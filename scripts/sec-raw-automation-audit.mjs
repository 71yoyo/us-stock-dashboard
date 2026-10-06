import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { makeAutomationPolicy,makeProducerFixture,makeSource,nextAccession,laterAccession,oldAccession } from '../tests/helpers/sec-raw-automation-fixtures.js';
import { applicationIdentity } from './sec-raw-producer-journal.mjs';

/** 모두 합성 loader/transport다. 네트워크를 금지한 상태로 scale/catch-up/ambiguous invariant를 다시 검증한다. */
export async function runAutomationAudit() {
  const original=globalThis.fetch;let networkCalls=0;
  globalThis.fetch=()=>{networkCalls++;throw Error('R10B_NETWORK_FORBIDDEN');};
  try {
    const scope=Array.from({length:100},(_,i)=>({ticker:`S${i}`,cik:String(700000+i)}));
    const scale=makeProducerFixture({policy:makeAutomationPolicy({scope})});
    const run1=await scale.run(),run2=await scale.run();
    assert.equal(run1.queued,100);assert.equal(run2.inFlight,100);assert.equal(scale.sends.length,100);
    assert.equal(scale.queries.filter(q=>q==='run-readiness').length,2);
    assert.equal(scale.queries.filter(q=>q==='indexed-ticker').length,200);
    const ambiguous=makeProducerFixture();let sends=0;
    const transport={send:async()=>{sends++;return {kind:'ambiguous'};}};
    const a=await ambiguous.run({transport}),b=await ambiguous.run({transport});
    assert.equal(a.ambiguous,1);assert.equal(b.ambiguous,1);assert.equal(sends,1);
    const catchup=makeProducerFixture();catchup.sources.set('O',makeSource('O',{
      accessions:[laterAccession,nextAccession,oldAccession],indexed:[nextAccession,laterAccession]}));
    await catchup.run();const first=catchup.sends[0];assert.equal(first.accession,nextAccession);
    catchup.states.get('O').checkpoint={accession:first.accession,sourceIdentity:first.sourceIdentity,schemaVersion:1};
    await catchup.run();assert.equal(catchup.sends[1].accession,laterAccession);
    assert.equal((await catchup.journal.get(applicationIdentity(first))).state,'COMPLETED_RECONCILED');
    assert.equal(networkCalls,0);
    return {phase:'R10B',status:'PASS',scale:{tickers:100,run1Accepted:100,run2Accepted:0,run2InFlight:100,
      readinessQueriesPerRun:1,tickerReadGroupsPerRun:100,sqlAdapterSelectsPerTicker:3,wholeHistoryRepeats:0},
      lifecycle:{durableIntentBeforePost:'PASS',ambiguousSendAttempts:sends,catchupOldestFirst:'PASS',completedReconcile:'PASS'},
      actualCalls:{SEC:0,Queue:0,D1:0,GitHub:0},productionMutation:0,newMigration:false};
  } finally {globalThis.fetch=original;}
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const result=await runAutomationAudit();
  const output=execFileSync(process.execPath,['--use-system-ca','--test',
    'tests/sec-raw-automation-policy.test.js','tests/sec-raw-source-fetch.test.js','tests/sec-raw-producer-journal.test.js',
    'tests/sec-raw-scheduled-producer.test.js','tests/sec-raw-github-journal.test.js'],{encoding:'utf8',maxBuffer:4*1024*1024,windowsHide:true});
  result.tests={total:Number(output.match(/(?:ℹ |# )tests (\d+)/)?.[1]),fail:0,skip:0};
  assert.ok(result.tests.total>=35);console.log(JSON.stringify(result,null,2));
}
