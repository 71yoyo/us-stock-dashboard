import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromotionFixture,sourceFixture,testAccession } from './helpers/sec-raw-promotion-fixtures.js';
import { loadHistoricalReferenceRuntime,historicalSemanticSnapshot } from './helpers/sec-raw-historical-reference.js';
import { importHistoricalSecRaw } from '../scripts/sec-raw-historical-import.mjs';
import { prepareHistoricalMutationPlan,executeHistoricalMutationPlan,summarizeHistoricalMutationPlans } from '../scripts/sec-raw-historical-plan.mjs';
import { readOnlyDatabase } from '../scripts/sec-raw-promotion.mjs';
import { rawSourceIdentity } from '../worker/src/sec-raw-message.js';
import { extractStandardRawMetrics } from '../worker/src/sec-standard-raw.js';

const plan=ctx=>prepareHistoricalMutationPlan({DB:ctx.DB,ticker:'O',accession:testAccession,
  sourceIdentity:ctx.envelope.historicalSourceIdentities.O,records:ctx.records});
const approvedApply=async ctx=>{
  const dry=await importHistoricalSecRaw(ctx.options),verify=await importHistoricalSecRaw({...ctx.options,verifyOnly:true});
  return importHistoricalSecRaw({...ctx.options,apply:true,enabled:true,productionApproval:true,
    evidence:{'dry-run':dry.receipt,'verify-only':verify.receipt}});
};
const writes=ctx=>ctx.stats.reduce((n,row)=>n+row.logicalChanges,0);

test('R8I-FIX 공식 dry-run은 summary/perTickerPlans와 registry/원자 action 계획 반환',async()=>{
  const ctx=await createPromotionFixture();try{
    const dry=await importHistoricalSecRaw(ctx.options),p=dry.perTickerPlans[0];
    assert.equal(dry.mode,'dry-run');assert.equal(dry.summary.raw,ctx.records.length);
    assert.equal(p.plannedRegistryResult,'ready');assert.deepEqual(p.runtimeTransition,{from:null,via:'running',to:'ready'});
    assert.deepEqual(p.actions.runtime,{initialize:1,claim:1,complete:1,logical:1});
    assert.deepEqual(p.actions.guard,{insert:1,delete:1,fenced:true});assert.equal(p.actions.registry.statusUpdate,1);
    assert.equal(p.plannedHistoricalCheckpoint.sourceProcessed,true);assert.equal(p.plannedHistoricalCheckpoint.allMetricsReviewed,true);
  }finally{ctx.sqlite.close();}
});

test('R8I-FIX dry-run INSERT/UPDATE/DELETE/DDL/run/batch 각각 0: 실수 호출도 즉시 실패',async()=>{
  const ctx=await createPromotionFixture();try{
    let run=0,batch=0;
    const original=ctx.DB.prepare.bind(ctx.DB);
    ctx.DB.prepare=sql=>{
      assert.match(sql,/^\s*SELECT\b/i);
      const st=original(sql);st.run=()=>{run++;throw Error('TEST_WRITE_FORBIDDEN');};return st;
    };
    ctx.DB.batch=()=>{batch++;throw Error('TEST_BATCH_FORBIDDEN');};ctx.reset();
    await importHistoricalSecRaw(ctx.options);assert.equal(writes(ctx),0);assert.equal(run,0);assert.equal(batch,0);
    const read=readOnlyDatabase(ctx.DB);
    for(const sql of ['INSERT INTO companies DEFAULT VALUES','UPDATE companies SET name=1','DELETE FROM companies','CREATE TABLE x(a)'])assert.throws(()=>read.prepare(sql));
    assert.throws(()=>read.prepare('SELECT 1').run());assert.throws(()=>read.batch([]));
    assert.equal(run,0);assert.equal(batch,0);
  }finally{ctx.sqlite.close();}
});

// 최소 합성 row로 10종목 scope와 25 review 정책을 검증한다. 실제 9062행 exact 검사는 cache audit가 담당한다.
async function syntheticTen(ctx) {
  const tickers=['NVDA','AAPL','MSFT','JPM','O','ABBV','ABT','AMZN','GOOGL','TSLA'],plans=[];
  const reviewTemplate=(await createReviewRecords())[0];
  for(const ticker of tickers){
    if(ticker!=='O')ctx.sqlite.prepare('INSERT INTO companies(ticker,name) VALUES (?,?)').run(ticker,'합성 scope');
    const records=structuredClone(ctx.records),n={O:6,ABT:5,TSLA:14}[ticker] || 0;
    for(let i=0;i<n;i++)records.push({...structuredClone(reviewTemplate),periodEnd:`${2000+i}-12-31`});
    plans.push(await prepareHistoricalMutationPlan({DB:ctx.DB,ticker,accession:testAccession,sourceIdentity:'b'.repeat(64),records}));
  }
  return plans;
}
async function createReviewRecords(){const ctx=await createPromotionFixture({review:true});try{return ctx.records.filter(row=>row.availability==='needs_review');}finally{ctx.sqlite.close();}}

test('R8I-FIX Run1 10/10 source checkpoint 계획',async()=>{
  const ctx=await createPromotionFixture();try{
    const plans=await syntheticTen(ctx),s=summarizeHistoricalMutationPlans(plans);
    assert.equal(s.plannedSourceCheckpoints,10);assert.equal(s.checkpointMutations,10);assert.equal(writes(ctx),0);
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX needs_review 25와 O6/ABT5/TSLA14 pending_review 보존',async()=>{
  const ctx=await createPromotionFixture();try{
    const plans=await syntheticTen(ctx),s=summarizeHistoricalMutationPlans(plans);assert.equal(s.needsReview,25);
    assert.deepEqual(s.reviewSummary.map(row=>[row.ticker,row.needsReview]),[['O',6],['ABT',5],['TSLA',14]]);
    for(const p of plans){const review=['O','ABT','TSLA'].includes(p.ticker);assert.equal(p.plannedRawStatus,review?'pending':'ready');
      assert.equal(p.plannedHistoricalCheckpoint.allMetricsReviewed,!review);}
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX Run2 completed 동일 source 전체 의미 mutation 0',async()=>{
  const ctx=await createPromotionFixture({review:true});try{
    await approvedApply(ctx);ctx.reset();const p=await plan(ctx);
    assert.equal(p.sameCompletedSourceShortcut,true);assert.equal(p.estimatedSemanticWrites,0);
    assert.equal(p.actions.raw.insert,0);assert.equal(p.actions.provenance.append,0);
    assert.equal(p.actions.checkpoint.mutations,0);assert.equal(p.actions.registry.statusUpdate,0);assert.equal(p.actions.runtime.logical,0);
    assert.equal(p.plannedRawStatus,'pending');assert.equal((await executeHistoricalMutationPlan(ctx.DB,p)).status,'unchanged');assert.equal(writes(ctx),0);
  }finally{ctx.sqlite.close();}
});

async function changedPlan(ctx,accession=testAccession,cash=11){
  const companyFacts=sourceFixture({cash,accession}),financialPeriods=ctx.input.financialPeriods;
  const records=extractStandardRawMetrics(companyFacts.facts,{financialPeriods});
  const sourceIdentity=await rawSourceIdentity({version:1,ticker:'O',accession,cik:String(companyFacts.cik),facts:companyFacts.facts,financialPeriods});
  return prepareHistoricalMutationPlan({DB:ctx.DB,ticker:'O',accession,sourceIdentity,records});
}
test('R8I-FIX same accession/changed identity는 compare/review/reprocess, 값 overwrite 없음',async()=>{
  const ctx=await createPromotionFixture();try{
    await approvedApply(ctx);const p=await changedPlan(ctx);
    assert.equal(p.sameCompletedSourceShortcut,false);assert.equal(p.plannedRegistryResult,'pending_review');
    assert.equal(p.review.valueCorrections,1);assert.equal(p.actions.raw.upsert,0);assert.equal(p.actions.provenance.append,1);
    assert.equal(p.actions.checkpoint.action,'update');await executeHistoricalMutationPlan(ctx.DB,p);
    assert.equal(ctx.sqlite.prepare("SELECT metric_value FROM sec_standard_raw_metrics WHERE metric_name='cash_and_cash_equivalents'").get().metric_value,10);
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX new accession 동일 값은 provenance append/새 checkpoint, raw no-op',async()=>{
  const ctx=await createPromotionFixture();try{
    await approvedApply(ctx);const p=await changedPlan(ctx,'0000726728-26-000002',10);
    assert.equal(p.plannedRegistryResult,'ready');assert.equal(p.sameCompletedSourceShortcut,false);
    assert.equal(p.actions.raw.insert,0);assert.equal(p.actions.raw.noOp,p.counts.raw);
    assert.equal(p.actions.provenance.append,p.counts.available);assert.equal(p.actions.checkpoint.action,'update');
    assert.equal((await executeHistoricalMutationPlan(ctx.DB,p)).status,'ready');
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX raw/provenance action 수는 실제 initial insert/append와 일치',async()=>{
  const ctx=await createPromotionFixture();try{
    const p=await plan(ctx);assert.equal(p.actions.raw.insert,p.counts.raw);assert.equal(p.actions.provenance.append,p.counts.available);
    await executeHistoricalMutationPlan(ctx.DB,p);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_metrics').get().n,p.actions.raw.insert);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_provenance').get().n,p.actions.provenance.append);
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX historical checkpoint는 pending metric과 source processed를 분리',async()=>{
  const ctx=await createPromotionFixture({review:true});try{
    const p=await plan(ctx);assert.equal(p.actions.checkpoint.action,'insert');assert.equal(p.plannedRawStatus,'pending');
    assert.equal(p.plannedHistoricalCheckpoint.sourceProcessed,true);assert.equal(p.plannedHistoricalCheckpoint.allMetricsReviewed,false);
    await executeHistoricalMutationPlan(ctx.DB,p);assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_raw_payload_checkpoint').get().n,1);
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX active lease/backoff는 runtime deferred/0 writes, retryNow만 backoff 허용',async()=>{
  const ctx=await createPromotionFixture();try{
    ctx.sqlite.prepare("INSERT INTO sec_raw_runtime(ticker,raw_status,lease_token,lease_until) VALUES ('O','running','synthetic-owner',?)").run(new Date(Date.now()+120000).toISOString());
    ctx.reset();let p=await plan(ctx);assert.equal(p.plannedRegistryResult,'deferred');assert.equal(p.estimatedSemanticWrites,0);
    assert.equal((await executeHistoricalMutationPlan(ctx.DB,p)).status,'deferred');assert.equal(writes(ctx),0);
    ctx.sqlite.prepare("UPDATE sec_raw_runtime SET raw_status='error',lease_token=NULL,lease_until=NULL,next_run_at=?,attempt_accession=?,attempt_data_version=2").run(new Date(Date.now()+120000).toISOString(),testAccession);
    p=await plan(ctx);assert.equal(p.plannedRegistryResult,'deferred');
    p=await prepareHistoricalMutationPlan({DB:ctx.DB,ticker:'O',accession:testAccession,sourceIdentity:'c'.repeat(64),records:ctx.records,retryNow:true});
    assert.equal(p.plannedRegistryResult,'ready');
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX 승인 checkpoint reference apply와 planner/executor semantic parity',async()=>{
  const ref=await loadHistoricalReferenceRuntime(),left=await createPromotionFixture({review:true}),right=await createPromotionFixture({review:true});
  try{
    const old=await ref({DB:left.DB,SEC_STANDARD_RAW_FIELDS_ENABLED:'true'},'O',testAccession,async()=>left.records,
      {sourceIdentity:left.envelope.historicalSourceIdentities.O,channel:'historical',strictReview:true,processingCheckpoint:true});
    const next=await executeHistoricalMutationPlan(right.DB,await plan(right));assert.deepEqual(next,old);
    assert.deepEqual(historicalSemanticSnapshot(right.sqlite),historicalSemanticSnapshot(left.sqlite));
  }finally{left.sqlite.close();right.sqlite.close();}
});
test('R8I-FIX budget 상한/semantic estimate/actual billed 구분',async()=>{
  const ctx=await createPromotionFixture();try{
    const p=await plan(ctx),s=summarizeHistoricalMutationPlans([p]);assert.ok(s.estimatedWrites<=50000);
    assert.equal(s.estimatedSemanticWrites,p.counts.raw+p.counts.provenance+6);
    assert.equal(s.actualBilledRowsWritten,'NOT MEASURED');
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX malformed/unsupported record는 계획/쓰기 전에 차단',async()=>{
  const ctx=await createPromotionFixture();try{
    ctx.reset();for(const records of [[],[{metricName:'total_debt'}],[...ctx.records,ctx.records[0]]]){
      await assert.rejects(prepareHistoricalMutationPlan({DB:ctx.DB,ticker:'O',accession:testAccession,sourceIdentity:'a'.repeat(64),records}));
    }assert.equal(ctx.stats.length,0);assert.equal(writes(ctx),0);
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX 승인 scope만 계획하고 LMT 추가/자동 company 확대 금지',async()=>{
  const ctx=await createPromotionFixture();try{
    ctx.sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('LMT','합성 보호')");
    assert.deepEqual((await importHistoricalSecRaw(ctx.options)).perTickerPlans.map(row=>row.ticker),['O']);
    ctx.reset();await assert.rejects(importHistoricalSecRaw({...ctx.options,tickers:['O','LMT']}),/TARGET_SCOPE/);assert.equal(writes(ctx),0);
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX planner 출력은 Production apply 권한/receipt pair 대체 불가',async()=>{
  const ctx=await createPromotionFixture();try{
    const dry=await importHistoricalSecRaw(ctx.options);ctx.reset();
    await assert.rejects(importHistoricalSecRaw({...ctx.options,apply:true,enabled:true,productionApproval:true,evidence:dry.summary}),/EVIDENCE/);
    await assert.rejects(importHistoricalSecRaw({...ctx.options,apply:true,productionApproval:true}));assert.equal(writes(ctx),0);
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX 계획에 secret/raw payload/SQL/value/reference 노출 없음',async()=>{
  const ctx=await createPromotionFixture();try{
    const serialized=JSON.stringify(await importHistoricalSecRaw(ctx.options));
    assert.doesNotMatch(serialized,/companyFacts|sourceBytes|sourceRefs|sec_tag|metricValue|calculationDetails|INSERT INTO|credential|Authorization/);
    assert.doesNotMatch(serialized,/synthetic-r8b-queue|aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX 공개 계획 복제/수정/다른 DB 실행을 차단하고 원문 사본 고정',async()=>{
  const ctx=await createPromotionFixture(),other=await createPromotionFixture();try{
    const p=await plan(ctx);assert.throws(()=>{p.actions.raw.insert=999;});
    await assert.rejects(executeHistoricalMutationPlan(ctx.DB,structuredClone(p)));
    await assert.rejects(executeHistoricalMutationPlan(other.DB,p));
    ctx.records[0].metricName='total_debt';assert.equal((await executeHistoricalMutationPlan(ctx.DB,p)).status,'ready');
  }finally{ctx.sqlite.close();other.sqlite.close();}
});
test('R8I-FIX 완료 identity shortcut 유지/다른 identity correction 재검토, overwrite 금지',async()=>{
  const ctx=await createPromotionFixture();try{
    const p=await plan(ctx);
    const other=await plan(ctx);await executeHistoricalMutationPlan(ctx.DB,other);
    ctx.sqlite.exec("UPDATE sec_standard_raw_metrics SET metric_value=99 WHERE metric_name='cash_and_cash_equivalents'");
    assert.equal((await executeHistoricalMutationPlan(ctx.DB,p)).status,'unchanged');
    // 다른 identity 재처리 때만 비교기간을 검토한다. 완료 identity shortcut 의미는 기존과 같다.
    const changed=await changedPlan(ctx);assert.equal(changed.plannedRegistryResult,'pending_review');
    await executeHistoricalMutationPlan(ctx.DB,changed);
    assert.equal(ctx.sqlite.prepare("SELECT metric_value FROM sec_standard_raw_metrics WHERE metric_name='cash_and_cash_equivalents'").get().metric_value,99);
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX checkpoint 실패 시 원자 raw/provenance/guard rollback 유지',async()=>{
  const ctx=await createPromotionFixture();try{
    const p=await plan(ctx);ctx.sqlite.exec("CREATE TRIGGER fail_plan BEFORE INSERT ON sec_raw_payload_checkpoint BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FAILURE'); END");
    assert.equal((await executeHistoricalMutationPlan(ctx.DB,p)).status,'error');
    for(const table of ['sec_standard_raw_metrics','sec_standard_raw_provenance','sec_raw_runtime_guard','sec_raw_payload_checkpoint'])
      assert.equal(ctx.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX 계획 이후 다른 source가 저장되면 claim 후 같은 core로 재계획',async()=>{
  const ctx=await createPromotionFixture();try{
    const initial=await plan(ctx);assert.equal(initial.plannedRegistryResult,'ready');
    await executeHistoricalMutationPlan(ctx.DB,await changedPlan(ctx,testAccession,11));
    assert.equal((await executeHistoricalMutationPlan(ctx.DB,initial)).status,'pending_review');
    assert.equal(ctx.sqlite.prepare("SELECT metric_value FROM sec_standard_raw_metrics WHERE metric_name='cash_and_cash_equivalents'").get().metric_value,11);
    assert.equal(ctx.sqlite.prepare('SELECT raw_status FROM sec_raw_runtime').get().raw_status,'pending');
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX provenance gap는 동일 source라도 shortcut 금지/append 복구 계획',async()=>{
  const ctx=await createPromotionFixture();try{
    await approvedApply(ctx);ctx.sqlite.exec('DELETE FROM sec_standard_raw_provenance');ctx.reset();
    const p=await plan(ctx);assert.equal(p.sameCompletedSourceShortcut,false);
    assert.equal(p.actions.raw.insert,0);assert.equal(p.actions.provenance.append,p.counts.available);
    assert.equal(writes(ctx),0);await executeHistoricalMutationPlan(ctx.DB,p);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_provenance').get().n,p.counts.available);
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX 공식 dry-run 계획 실패는 PASS receipt/부분 plan 생성 금지',async()=>{
  const ctx=await createPromotionFixture();try{
    const original=ctx.DB.prepare.bind(ctx.DB);
    ctx.DB.prepare=sql=>{
      if(sql.includes('AS existing_ticker'))throw Error('SYNTHETIC_PLANNING_FAILURE');
      return original(sql);
    };ctx.reset();const result=await importHistoricalSecRaw(ctx.options);
    assert.equal(result.results[0].status,'error');assert.equal(result.receipt,undefined);
    assert.equal(result.summary,null);assert.deepEqual(result.perTickerPlans,[]);assert.equal(writes(ctx),0);
  }finally{ctx.sqlite.close();}
});
test('R8I-FIX 공식 dry-run의 read-only 계획을 write DB에 직접 실행할 수 없음',async()=>{
  const ctx=await createPromotionFixture();try{
    const dry=await importHistoricalSecRaw(ctx.options);ctx.reset();
    await assert.rejects(executeHistoricalMutationPlan(ctx.DB,dry.perTickerPlans[0]));assert.equal(writes(ctx),0);
  }finally{ctx.sqlite.close();}
});
