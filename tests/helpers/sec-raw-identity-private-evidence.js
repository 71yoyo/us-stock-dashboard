import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { latestRawAccession } from '../../worker/src/sec-standard-raw-runtime.js';
import { identityMessages, cacheProducerFixture } from './sec-raw-identity-fixtures.js';

const read=file=>JSON.parse(readFileSync(file,'utf8'));
export const expectedAaplLegacy='88012b7063102e8bacedd70d042b441422241350e6bc347517d45ddf3cca9def';
export const expectedAaplCanonical='7e1312cd69b64b79f47ac1062c4c4f4356e553052e0d3c0ca07706b3b5cf33c6';

/** R10C-2 전용 로컬 감사 입력이다. 실제 private evidence는 일반 테스트/CI fixture에 복사하지 않는다. */
export function readPrivateIdentityEvidenceFixtures(projectRoot=process.cwd()) {
  const base=file=>resolve(projectRoot,file);
  const ledger=read(base('backups/r4/acquisition.json'));
  const prior=read(base('backups/r9d/production-baseline.json'));
  const proof=read(base('backups/r10a/production-read.json'));
  assert.equal(proof.status,'PASS','승인된 production metadata 증거 필요');
  return ['NVDA','GOOGL','AAPL','TSLA','MSFT','AMZN','O','JPM','ABBV','ABT'].map(ticker=>{
    const approval=ledger.find(row=>row.ticker===ticker);assert.ok(approval);
    const bytes=readFileSync(base(`backups/r4/cache/${ticker}.json`));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),approval.sourceSha256,'승인 cache hash 불일치');
    const companyFacts=JSON.parse(bytes);assert.equal(Number(companyFacts.cik),approval.cik);
    const financialPeriods=prior.financialPeriods[ticker];assert.ok(Array.isArray(financialPeriods));
    const stored=proof.checkpoints.find(row=>row.ticker===ticker && row.channel==='compact');
    return {ticker,cik:String(approval.cik),accession:latestRawAccession(companyFacts.facts),companyFacts,financialPeriods,
      checkpoint:stored?{accession:stored.accession,sourceIdentity:stored.source_identity,schemaVersion:stored.schema_version}:null,
      evidenceAsOf:proof.completedAt};
  });
}

export { identityMessages, cacheProducerFixture };
