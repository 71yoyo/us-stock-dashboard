import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPrivateIdentityEvidenceFixtures, identityMessages, cacheProducerFixture,
  expectedAaplLegacy, expectedAaplCanonical } from '../tests/helpers/sec-raw-identity-private-evidence.js';
import { compactSemanticsExact } from './sec-raw-producer-identity.mjs';
import { validateCompactSecRawMessage } from '../worker/src/sec-raw-message.js';

/** 승인 10종목 cache만 비교한다. Production checkpoint는 과거 metadata 증거이며 fresh 조회가 아니다. */
export async function runIdentityCompatibilityAudit() {
  const original=globalThis.fetch;let networkCalls=0;
  globalThis.fetch=()=>{networkCalls++;throw new Error('R10C2_NETWORK_FORBIDDEN');};
  try {
    const rows=[];
    for (const item of readPrivateIdentityEvidenceFixtures()) {
      const {legacy,canonicalMessage}=await identityMessages(item);
      const semanticEquality=await compactSemanticsExact(legacy,canonicalMessage);
      assert.equal(semanticEquality,true,'compact 의미 차이는 bridge 승인 불가');
      const differs=legacy.sourceIdentity!==canonicalMessage.sourceIdentity;
      let productionDecision=null;
      if (item.checkpoint) {
        assert.equal(legacy.sourceIdentity,item.checkpoint.sourceIdentity,'운영 V1 checkpoint 재현 실패');
        const f=await cacheProducerFixture(item,item.checkpoint);
        const result=await f.run({enqueue:false,dryRun:true});
        assert.equal(result.failed,0);assert.equal(result.detected,0);assert.equal(result.unchanged,1);assert.equal(f.sends.length,0);
        assert.equal(Object.keys((await f.backend.load()).state.entries).length,0,'fake completion/INTENT 금지');
        productionDecision=result.identityDecisions[0].decision;
      }
      if(item.ticker==='AAPL'){
        assert.equal(legacy.sourceIdentity,expectedAaplLegacy);assert.equal(canonicalMessage.sourceIdentity,expectedAaplCanonical);
        assert.equal(productionDecision,'UNCHANGED_COMPAT');
        assert.equal((await validateCompactSecRawMessage(canonicalMessage)).records.length,67);
      }
      rows.push({ticker:item.ticker,accession:item.accession,legacyIdentity:legacy.sourceIdentity,canonicalIdentity:canonicalMessage.sourceIdentity,
        semanticEquality,classification:differs?'ORDER_NORMALIZATION_ONLY':'SAME_IDENTITY',productionDecision,
        checkpointEvidenceAsOf:item.checkpoint?item.evidenceAsOf:null});
    }
    // 일반 테스트에서 분리한 실제 evidence 집계 계약도 이 전용 감사에서 그대로 강제한다.
    assert.equal(rows.length,10);
    assert.equal(rows.filter(row=>row.classification==='SAME_IDENTITY').length,2);
    assert.equal(rows.filter(row=>row.classification==='ORDER_NORMALIZATION_ONLY').length,8);
    assert.equal(networkCalls,0);
    return {phase:'R10C-2',status:'PASS',rows,sameIdentity:rows.filter(row=>row.classification==='SAME_IDENTITY').length,
      normalizedOnlyDifferences:rows.filter(row=>row.classification==='ORDER_NORMALIZATION_ONLY').length,
      actualSemanticDifferences:0,externalCalls:0,productionWrites:0,publish:0,newMigration:false};
  } finally {globalThis.fetch=original;}
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {console.log(JSON.stringify(await runIdentityCompatibilityAudit(),null,2));}
  catch {console.log(JSON.stringify({phase:'R10C-2',status:'FAIL',category:'OFFLINE_IDENTITY_AUDIT_FAILED',externalCalls:0}));process.exitCode=1;}
}
