import { prepareStandardRawStorePlan,validateStandardRawRecords } from '../worker/src/sec-standard-raw-store.js';
import { inspectRawRecordCompletion,lookupIncrementalReviews,rawReviewPending,rawCheckpointAllowed,
  rawClaimCondition,runRawRecordRuntime } from '../worker/src/sec-standard-raw-incremental.js';
import { SEC_RAW_SCHEMA_VERSION,SEC_RAW_DATA_VERSION } from '../worker/src/sec-raw-runtime-policy.js';
import { readOnlyDatabase,promotionHash,estimateHistoricalWrites } from './sec-raw-promotion.mjs';

const validatedPlans=new WeakMap();
const freeze=value=>{
  if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
};
const countsFor=records=>({raw:records.length,available:records.filter(row=>row.availability==='available').length,
  provenance:records.filter(row=>row.provenance).length,missing:records.filter(row=>row.availability==='missing').length,
  needsReview:records.filter(row=>row.availability==='needs_review').length});
const zeroActions=()=>({raw:{insert:0,upsert:0,noOp:0},provenance:{append:0,noOp:0},
  runtime:{initialize:0,claim:0,complete:0,logical:0},registry:{statusUpdate:0},
  checkpoint:{action:'no-op',mutations:0},guard:{insert:0,delete:0,fenced:false}});

/**
 * 원문을 공개 계획에 싣지 않고 검증된 records를 내부에만 고정한다.
 * 계획은 승인이 아니다. 실행 권한은 importer의 기존 envelope/evidence/target guard가 계속 담당한다.
 */
export async function prepareHistoricalMutationPlan({DB,ticker,accession,sourceIdentity,records,retryNow=false}) {
  if(!/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker || '') || !/^\d{10}-\d{2}-\d{6}$/.test(accession || '')
    || !/^[a-f0-9]{64}$/.test(sourceIdentity || '')) throw new Error('SEC historical 계획 identity가 유효하지 않습니다.');
  validateStandardRawRecords(records);
  const snapshot=freeze(structuredClone(records));
  return prepareCore({DB,ticker,accession,sourceIdentity,records:snapshot,retryNow},false);
}

// claim 후에도 같은 planning core를 사용한다. 실제 lease/fence 획득과 batch는 기존 runtime만 담당한다.
async function prepareCore(input,afterClaim) {
  const {DB,ticker,accession,sourceIdentity,records,retryNow}=input;
  const read=DB ? readOnlyDatabase(DB) : null;
  const options={sourceIdentity,channel:'historical',strictReview:true,processingCheckpoint:true,retryNow};
  const state=read ? await read.prepare('SELECT * FROM sec_raw_runtime WHERE ticker=?').bind(ticker).first() : null;
  const completion=read ? await inspectRawRecordCompletion(read,ticker,accession,options,state) : {checkpoint:null,result:null};
  let eligible=true;
  if(state && !afterClaim && !completion.result){
    const now=new Date().toISOString();
    eligible=Boolean((await read.prepare(`SELECT CASE WHEN ${rawClaimCondition(options)} THEN 1 ELSE 0 END AS eligible
      FROM sec_raw_runtime WHERE ticker=?`).bind(now,now,accession,SEC_RAW_DATA_VERSION,ticker).first()).eligible);
  }
  const shortcut=Boolean(!afterClaim && completion.result),deferred=!shortcut && !eligible;
  const reviews=shortcut || deferred ? [] : read ? await lookupIncrementalReviews(read,ticker,records) : [];
  const pending=shortcut ? Boolean(completion.result.reviewPending) : rawReviewPending(records,reviews,options);
  const storePlan=shortcut || deferred ? null : await prepareStandardRawStorePlan(read,ticker,records);
  const actions=zeroActions();
  if(storePlan){
    actions.raw={...storePlan.raw};actions.provenance={...storePlan.provenance};
    actions.runtime={initialize:state?0:1,claim:1,complete:1,logical:1};
    actions.registry.statusUpdate=1;
    if(rawCheckpointAllowed(options,pending))actions.checkpoint={action:completion.checkpoint?'update':'insert',mutations:1};
    actions.guard={insert:1,delete:1,fenced:true};
  }else if(shortcut){
    actions.raw.noOp=records.length;actions.provenance.noOp=records.filter(row=>row.provenance).length;
  }
  const result=shortcut?'unchanged':deferred?'deferred':pending?'pending_review':'ready';
  const rawStatus=shortcut || deferred ? state?.raw_status ?? 'pending' : pending?'pending':'ready';
  const plan=freeze({version:1,schemaVersion:SEC_RAW_SCHEMA_VERSION,dataVersion:SEC_RAW_DATA_VERSION,
    ticker,accession,sourceIdentity,counts:countsFor(records),stateVerified:Boolean(read),sameCompletedSourceShortcut:shortcut,
    plannedRegistryResult:result,plannedRawStatus:rawStatus,
    plannedHistoricalCheckpoint:{action:actions.checkpoint.action,sourceProcessed:shortcut || actions.checkpoint.mutations===1,
      allMetricsReviewed:!pending && !deferred,channel:'historical'},
    runtimeTransition:{from:state?.raw_status ?? null,via:storePlan?'running':null,to:rawStatus},actions,
    review:{needsReview:records.filter(row=>row.availability==='needs_review').length,comparisonCandidates:reviews.length,
      valueCorrections:reviews.filter(row=>row.old_availability==='available').length,pending},
    estimatedSemanticWrites:actions.raw.insert+actions.raw.upsert+actions.provenance.append
      +actions.runtime.initialize+actions.runtime.claim+actions.runtime.complete+actions.checkpoint.mutations
      +actions.guard.insert+actions.guard.delete});
  validatedPlans.set(plan,{...input,options,reviews,pending,storePlan});
  return plan;
}

/** 복제/변경한 공개 JSON은 실행하지 않는다. 동일 validated plan의 records를 직접 사용한다. */
export async function executeHistoricalMutationPlan(DB,plan) {
  const input=validatedPlans.get(plan);
  if(!input || input.DB!==DB)throw new Error('SEC historical 실행 계획이 검증되지 않았습니다.');
  return runRawRecordRuntime({DB,SEC_STANDARD_RAW_FIELDS_ENABLED:'true'},plan.ticker,plan.accession,
    async()=>input.records,{...input.options,prepareMutation:async records=>{
      const claimedPlan=await prepareCore({...input,records},true);
      const execution=validatedPlans.get(claimedPlan);
      return {reviews:execution.reviews,pending:execution.pending,storePlan:execution.storePlan};
    }});
}

/** 집계는 각 ticker의 동일 계획으로만 만든다. 보수적 상한·의미적 writes·실제 과금은 구분한다. */
export function summarizeHistoricalMutationPlans(plans) {
  if(!plans.length || plans.some(plan=>!validatedPlans.has(plan)))throw new Error('SEC historical 계획 집계가 유효하지 않습니다.');
  const totals={raw:0,available:0,provenance:0,missing:0,needsReview:0};
  for(const plan of plans)for(const key of Object.keys(totals))totals[key]+=plan.counts[key];
  return freeze({version:1,schemaVersion:SEC_RAW_SCHEMA_VERSION,dataVersion:SEC_RAW_DATA_VERSION,
    datasetIdentity:promotionHash(plans.map(({ticker,accession,sourceIdentity})=>({ticker,accession,sourceIdentity}))),
    ...totals,plannedSourceCheckpoints:plans.filter(plan=>plan.plannedHistoricalCheckpoint.sourceProcessed).length,
    checkpointMutations:plans.reduce((n,plan)=>n+plan.actions.checkpoint.mutations,0),
    estimatedWrites:estimateHistoricalWrites(totals),
    estimatedSemanticWrites:plans.reduce((n,plan)=>n+plan.estimatedSemanticWrites,0),actualBilledRowsWritten:'NOT MEASURED',
    stateVerified:plans.every(plan=>plan.stateVerified),
    reviewSummary:plans.filter(plan=>plan.review.pending).map(plan=>({ticker:plan.ticker,...plan.review})),
    runtimeStatuses:Object.fromEntries(plans.map(plan=>[plan.ticker,plan.plannedRegistryResult]))});
}
