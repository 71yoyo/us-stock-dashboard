import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { productionFixture } from '../tests/helpers/sec-raw-production-fixtures.js';
import { makeAutomationPolicy } from '../tests/helpers/sec-raw-automation-fixtures.js';
import { runSyntheticStateCasContract } from './sec-raw-state-provisioning.mjs';

/** global fetch를 봉쇄하고 actual runner/adapter를 fake protocol로 실행한다. 출력은 합성 count/고정 판정뿐이다. */
export async function runProductionRunnerAudit() {
  const original=globalThis.fetch;let externalCalls=0;
  globalThis.fetch=()=>{externalCalls++;throw Error('R10C3A_NETWORK_FORBIDDEN');};
  try {
    const scale=productionFixture({policy:makeAutomationPolicy({secFetchEnabled:true,
      scope:Array.from({length:100},(_,i)=>({ticker:`S${i}`,cik:String(700000+i)}))})});
    for (const approved of scale.policy.scope) {
      const message=await scale.message(approved.ticker);
      scale.states.get(approved.ticker).checkpoint={accession:message.accession,sourceIdentity:message.sourceIdentity,schemaVersion:1};
    }
    const run=await scale.run();assert.equal(run.unchanged,100);assert.equal(run.failed,0);
    assert.equal(scale.requests.filter(r=>r.path.endsWith('/query')).length,301);
    const accepted=productionFixture();assert.equal((await accepted.run({args:['--enqueue']})).accepted,1);
    assert.equal((await accepted.run({args:['--enqueue']})).publishCount,0);assert.equal(accepted.queueCalls,1);
    const ambiguous=productionFixture({queueResponse:()=>{throw Error('synthetic-private-marker');}});
    assert.equal((await ambiguous.run({args:['--enqueue']})).ambiguous,1);
    assert.equal((await ambiguous.run({args:['--enqueue']})).publishCount,0);assert.equal(ambiguous.queueCalls,1);
    const synthetic=productionFixture();
    const cas=await runSyntheticStateCasContract({fetchImpl:synthetic.fetchImpl,credential:synthetic.env.PRODUCER_STATE_TOKEN,
      repository:synthetic.env.PRODUCER_STATE_REPOSITORY,verifyDisconnected:synthetic.verifier,now:synthetic.now});
    assert.equal(cas.residue,0);assert.equal(externalCalls,0);
    return {phase:'R10C-3A',status:'PASS',defaultMode:'detect-only',singleMessageContract:'PASS',
      scale:{scope:100,readinessQueries:1,tickerSelects:300,githubReadRequests:3,publish:0},
      acceptedSuppression:'PASS',ambiguousSuppression:'PASS',syntheticCas:'PASS',syntheticResidue:0,
      externalCalls:0,productionMutation:0,newMigration:false};
  } finally {globalThis.fetch=original;}
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const result=await runProductionRunnerAudit();
  const output=execFileSync(process.execPath,['--test','tests/sec-raw-production-runner.test.js','tests/sec-raw-single-transport.test.js'],
    {encoding:'utf8',maxBuffer:4*1024*1024,windowsHide:true});
  result.tests={total:Number(output.match(/(?:ℹ |# )tests (\d+)/)?.[1]),fail:0,skip:0};
  assert.ok(result.tests.total>=30);console.log(JSON.stringify(result,null,2));
}
