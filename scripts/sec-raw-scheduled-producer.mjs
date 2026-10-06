import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { validateAutomationPolicy, assertPolicyCurrent, assertPolicyMessage, errorCategory, safeError } from './sec-raw-automation-policy.mjs';
import { establishReadiness, assertReadiness } from './sec-raw-automation-readiness.mjs';
import { createSecSourceFetcher } from './sec-raw-source-fetch.mjs';
import { createProducerJournal, createMemoryJournalBackend, createLocalFixtureJournalBackend, applicationIdentity } from './sec-raw-producer-journal.mjs';
import { discoverAccessions, buildDiscoveredMessage } from './sec-raw-source-discovery.mjs';
import { classifyCompactCheckpoint, legacyJournalAlias, compactIdentityAlgorithms } from './sec-raw-producer-identity.mjs';

const globalFailures=new Set(['POLICY_INVALID','POLICY_TIME','RELEASE_MISMATCH','TARGET_MISMATCH','READINESS_INVALID','RECEIPT_INVALID',
  'SEC_FORBIDDEN','D1_READ','QUEUE_AUTH','QUEUE_TARGET','JOURNAL_IO','JOURNAL_CAS','LOCK_STALE','LOCK_BUSY','FETCH_BUDGET']);

/** scheduler 미연결 core다. 실제 enqueue는 명시적 flag + policy + transport가 모두 있을 때만 허용하며 기본값은 detect-only다. */
export async function runScheduledSecRawProducer({policy:input,release,target,reader,journal,sourceLoader,
  fetchImpl,userAgent,transport,enqueue=false,dryRun=true,now=Date.now,sleep,random,signal,runId=randomUUID(),owner=randomUUID(),reviewReader}={}) {
  const start=now(),policy=validateAutomationPolicy(input,{release,target,now:start});
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(owner) || !journal || !reader || (!sourceLoader && !policy.secFetchEnabled) ||
      (enqueue && !dryRun && (!policy.productionEnqueueEnabled || !transport || (transport.kind==='official-rest' && !journal.productionDurable)))) throw safeError('POLICY_INVALID');
  // 주입 loader는 cache/fake 전용이다. live loader도 같은 run의 전역 budget을 공유한다.
  const fetcher=!sourceLoader?createSecSourceFetcher({fetchImpl,userAgent,now,sleep,random,signal,
    maxFetchAttempts:policy.maxFetchAttempts,maxProviderRequests:policy.maxProviderRequests}):null;
  const load=sourceLoader??(async approved=>({submissions:await fetcher.submissions(approved),companyFacts:await fetcher.companyFacts(approved)}));
  const summary={runId,policyHash:policy.policyManifestHash,release,scopeCount:policy.scope.length,checked:0,unchanged:0,
    sourceNotIndexed:0,queued:0,reviewBlocked:0,ambiguous:0,failed:0,budgetSkipped:0,inFlight:0,detected:0,
    operatorRequired:0,stopped:false,durationClass:'SHORT',errorCategories:[],identityAlgorithms:compactIdentityAlgorithms,
    unchangedCompat:0,identityDecisions:[]};
  const errors=new Set(); let attempts=0,acquired=false;
  try {
    await journal.acquire({runId,owner,target:policy.target}); acquired=true;
    const receipt=await establishReadiness({policy,reader,runId,now});
    for (let index=0;index<policy.scope.length;index++) {
      const approved=policy.scope[index]; summary.checked++;
      try {
        assertReadiness(receipt,policy,runId,now());
        const state=await reader.ticker(approved.ticker);
        const reviewEvidence=reviewReader?await reviewReader(approved.ticker):undefined;
        await journal.reconcile(approved.ticker,{checkpoint:state.checkpoint,reviewEvidence});
        // ticker당 pending accession은 하나다. 미확정된 이전 message를 건너뛰어 새 accession을 enqueue하지 않는다.
        const pending=await journal.listUnresolved(approved.ticker);
        if (pending.length) {
          if (pending.some(e=>e.state==='AMBIGUOUS')) summary.ambiguous++;
          else if (pending.some(e=>e.state==='OPERATOR_REQUIRED')) summary.operatorRequired++;
          else summary.inFlight++;
          continue;
        }
        const source=await load(approved);
        const candidates=discoverAccessions({...source,approved,allowedForms:policy.allowedForms,checkpoint:state.checkpoint,historical:receipt.historical[approved.ticker]});
        let found=false;
        for (const candidate of candidates) {
          const deferred=await journal.delayed(approved.ticker,candidate.accession);
          if (deferred && (deferred.status==='OPERATOR_REQUIRED' || Date.parse(deferred.nextCheckAt)>now())) {
            if (deferred.status==='OPERATOR_REQUIRED') summary.operatorRequired++; else summary.sourceNotIndexed++;
            found=true; break;
          }
          const message=await buildDiscoveredMessage({approved,candidate,companyFacts:source.companyFacts,financialPeriods:state.financialPeriods,
            enqueuedAt:new Date(now()).toISOString()});
          if (!message) {
            await journal.deferNotIndexed({ticker:approved.ticker,accession:candidate.accession,runId,owner});
            summary.sourceNotIndexed++; found=true; break;
          }
          assertPolicyMessage(policy,message);
          const comparison=await classifyCompactCheckpoint({checkpoint:state.checkpoint,message,companyFacts:source.companyFacts,
            financialPeriods:state.financialPeriods});
          summary.identityDecisions.push({ticker:approved.ticker,accession:message.accession,decision:comparison.decision,reason:comparison.reason});
          if (['UNCHANGED','UNCHANGED_COMPAT'].includes(comparison.decision)) {
            if (comparison.decision==='UNCHANGED_COMPAT') summary.unchangedCompat++;
            continue;
          }
          const key=applicationIdentity(message);let existing=await journal.get(key);
          // 기존 V1 REVIEW/COMPLETED journal에 대응해도 새 V2 INTENT나 완료 record를 만들지 않는다.
          if (!existing) {
            const alias=await legacyJournalAlias(message,source.companyFacts,state.financialPeriods);
            if (alias && alias.sourceIdentity!==message.sourceIdentity) existing=await journal.get(applicationIdentity(alias));
          }
          if (existing) {
            // source 처리 증거가 있는 review는 재발행하지 않지만 그 뒤의 새 accession까지 영구 차단하지 않는다.
            if (existing.state==='REVIEW_BLOCKED') {summary.reviewBlocked++;found=true;continue;}
            if (existing.state==='FAILED_SAFE') {summary.operatorRequired++;found=true;break;}
            if (existing.state==='COMPLETED_RECONCILED') continue;
            throw safeError('OPERATOR_REQUIRED');
          }
          found=true;
          if (!enqueue || dryRun) {summary.detected++;break;}
          assertReadiness(receipt,policy,runId,now()); assertPolicyCurrent(policy,now());
          const intent=await journal.putIntent({message,policy,runId,owner,runPublishes:attempts});
          if (intent.existing) throw safeError('OPERATOR_REQUIRED');
          attempts++;
          // durable INTENT 확정 후에만 전송한다. 예기치 않은 throw는 전송 여부가 불명확하므로 AMBIGUOUS로 닫는다.
          let result;
          try { result=await transport.send(message,{policy,receipt,runId,enqueue:true}); }
          catch { result={kind:'ambiguous',category:'QUEUE_AMBIGUOUS'}; }
          if (result?.kind==='accepted') {await journal.markAccepted(key);summary.queued++;}
          else if (result?.kind==='rejected') {
            const category=['QUEUE_AUTH','QUEUE_TARGET','QUEUE_REJECTED'].includes(result.category)?result.category:'QUEUE_REJECTED';
            await journal.markFailed(key,category); throw safeError(category);
          } else {await journal.markAmbiguous(key);summary.ambiguous++;errors.add('QUEUE_AMBIGUOUS');}
          break;
        }
        if (!found) summary.unchanged++;
      } catch (error) {
        const category=errorCategory(error);errors.add(category);
        if (category==='BUDGET_EXHAUSTED') summary.budgetSkipped++; else summary.failed++;
        if (globalFailures.has(category)) {summary.stopped=true;break;}
      }
    }
  } catch (error) {errors.add(errorCategory(error));summary.failed++;summary.stopped=true;}
  finally {
    if (acquired) try {await journal.release({runId,owner});} catch {errors.add('JOURNAL_IO');summary.stopped=true;}
  }
  summary.errorCategories=[...errors].sort();
  const duration=now()-start; summary.durationClass=duration<1000?'SHORT':duration<60000?'MEDIUM':'LONG';
  return summary;
}

/** 로컬 CLI는 network transport를 제공하지 않는다. 상태/원천은 ignored fixture만 받고 enqueue flag 자체를 거부한다. */
export async function runLocalProducerCli(args) {
  if (args.length!==2 || args[0]!=='--fixture') throw safeError('POLICY_INVALID');
  const file=resolve(args[1]);
  try {execFileSync('git',['check-ignore','--quiet',file],{stdio:'ignore'});} catch {throw safeError('POLICY_INVALID');}
  let config; try {config=JSON.parse(readFileSync(file,'utf8'));} catch {throw safeError('SOURCE_INVALID');}
  const release=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const reader={identity:async()=>config.identity,readiness:async()=>config.readiness,ticker:async ticker=>config.states[ticker]};
  let backend=createMemoryJournalBackend();
  if (config.journalFile) {
    const journalFile=resolve(dirnameForFile(file),config.journalFile);
    try {execFileSync('git',['check-ignore','--quiet',journalFile],{stdio:'ignore'});} catch {throw safeError('POLICY_INVALID');}
    backend=createLocalFixtureJournalBackend(journalFile);
  }
  const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw safeError('POLICY_INVALID');};
  try {return await runScheduledSecRawProducer({policy:config.policy,release,target:config.policy.target,reader,journal:createProducerJournal(backend),
    sourceLoader:async approved=>config.sources[approved.ticker]});}
  finally {globalThis.fetch=originalFetch;}
}
function dirnameForFile(file) { return resolve(file,'..'); }
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {console.log(JSON.stringify(await runLocalProducerCli(process.argv.slice(2))));}
  catch (error) {console.log(JSON.stringify({status:'STOP',error:errorCategory(error)}));process.exitCode=1;}
}
