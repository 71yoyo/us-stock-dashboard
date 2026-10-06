import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { latestRawAccession } from '../../worker/src/sec-standard-raw-runtime.js';
import { buildCompactSecRawMessage } from '../../scripts/sec-raw-compact-producer.mjs';
import { buildDiscoveredMessage } from '../../scripts/sec-raw-source-discovery.mjs';
import { validateCompactSecRawMessage } from '../../worker/src/sec-raw-message.js';
import { makeProducerFixture, makeAutomationPolicy } from './sec-raw-automation-fixtures.js';

export const approvedIdentityTickers=['NVDA','GOOGL','AAPL','TSLA','MSFT','AMZN','O','JPM','ABBV','ABT'];
export const expectedAaplLegacy='88012b7063102e8bacedd70d042b441422241350e6bc347517d45ddf3cca9def';
export const expectedAaplCanonical='7e1312cd69b64b79f47ac1062c4c4f4356e553052e0d3c0ca07706b3b5cf33c6';
const read=file=>JSON.parse(readFileSync(file,'utf8'));

/** 이미 승인한 ignored cache/metadata만 읽는다. 원문은 반환해 메모리에서 쓰며 로그/fixture 파일로 복제하지 않는다. */
export function readIdentityCacheFixtures(projectRoot=process.cwd()) {
  const base=file=>resolve(projectRoot,file);
  const ledger=read(base('backups/r4/acquisition.json'));
  const prior=read(base('backups/r9d/production-baseline.json'));
  const proof=read(base('backups/r10a/production-read.json'));
  assert.equal(proof.status,'PASS','승인된 production metadata 증거 필요');
  return approvedIdentityTickers.map(ticker=>{
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

export async function identityMessages(item) {
  const enqueuedAt='2026-10-06T00:00:00.000Z';
  const legacy=await buildCompactSecRawMessage({...item,enqueuedAt});
  const canonicalMessage=await buildDiscoveredMessage({approved:{ticker:item.ticker,cik:item.cik},candidate:{accession:item.accession},...item,enqueuedAt});
  return {legacy,canonicalMessage};
}

/** 실제 운영 DB/journal을 주입하지 않는 disposable producer fixture다. */
export async function cacheProducerFixture(item,checkpoint) {
  const f=makeProducerFixture({policy:makeAutomationPolicy({scope:[{ticker:item.ticker,cik:item.cik}]})});
  const {legacy}=await identityMessages(item),{records}=await validateCompactSecRawMessage(legacy);
  const selected=Object.values(legacy.facts).flatMap(tags=>Object.values(tags)).flatMap(tag=>Object.values(tag.units)).flat()[0];
  f.sources.set(item.ticker,{companyFacts:item.companyFacts,submissions:{cik:Number(item.cik),tickers:[item.ticker],filings:{recent:{
    accessionNumber:[item.accession],filingDate:[selected.filed],form:[selected.form]},files:[]}}});
  f.states.set(item.ticker,{checkpoint,runtime:{raw_status:'ready'},financialPeriods:item.financialPeriods});
  Object.assign(f.readiness[0],{historical_accession:item.accession,historical_source_identity:legacy.sourceIdentity,
    record_count:records.length,available_count:records.filter(row=>row.availability==='available').length});
  return f;
}
