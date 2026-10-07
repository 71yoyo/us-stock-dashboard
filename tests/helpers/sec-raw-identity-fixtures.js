import { makeProducerFixture, makeAutomationPolicy } from './sec-raw-automation-fixtures.js';
import { buildCompactSecRawMessage } from '../../scripts/sec-raw-compact-producer.mjs';
import { buildDiscoveredMessage } from '../../scripts/sec-raw-source-discovery.mjs';
import { validateCompactSecRawMessage } from '../../worker/src/sec-raw-message.js';

// 공개 CI에서는 과거 기업 자료 대신 작고 재현 가능한 합성 accession만 사용한다.
export const approvedIdentityTickers = ['TEST','DEMO','SYN2','SYN3','SYN4','SYN5','SYN6','SYN7','SYN8','SYN9'];
export const expectedSyntheticLegacy = '53b6a244488b16b503f66d843e4a86921bce3d5b57b6dda3048f0c042cc01f7e';
export const expectedSyntheticCanonical = '53b6a244488b16b503f66d843e4a86921bce3d5b57b6dda3048f0c042cc01f7e';
export const expectedSyntheticSecondary = 'da94e3401f73c0b4973726ea7c005ff8b121745940b9d57278be56a56f4f49e0';
export const expectedSyntheticCompatLegacy = '3f2965f14f6eb494b86c8d38b4c430c7bcdcc72a7e12772c80e62a3527009a4f';
const accessionFor = cik => `${cik}-26-000001`;

function companyFactsFor(cik, reverseRows) {
  const accession = accessionFor(cik), filed = '2026-02-25';
  const annual = (year, value) => ({ start:`${year}-01-01`, end:`${year}-12-31`, val:value,
    form:'10-K', fp:'FY', fy:year, filed, accn:accession });
  const instant = (year, value) => ({ end:`${year}-12-31`, val:value, form:'10-K', fp:'FY', fy:year, filed, accn:accession });
  const rows = Array.from({length:12},(_,index)=>index+1);
  if (reverseRows) rows.reverse();
  const facts = { 'us-gaap': {
    Revenues:{units:{USD:rows.map(index=>annual(2013+index,index*10))}},
    NetIncomeLoss:{units:{USD:rows.map(index=>annual(2013+index,index*2))}},
    CashAndCashEquivalentsAtCarryingValue:{units:{USD:rows.map(index=>instant(2013+index,index*3))}},
    Assets:{units:{USD:rows.map(index=>instant(2013+index,index*100))}},
    StockholdersEquity:{units:{USD:rows.map(index=>instant(2013+index,index*40))}},
    WeightedAverageNumberOfSharesOutstandingBasic:{units:{shares:rows.map(index=>annual(2013+index,index*1000))}},
    WeightedAverageNumberOfDilutedSharesOutstanding:{units:{shares:rows.map(index=>annual(2013+index,index*1100))}}
  }};
  return { cik:Number(cik), facts };
}

export function readSyntheticIdentityFixtures() {
  return approvedIdentityTickers.map((ticker,index)=>{
    const cik=String(index+1).padStart(10,'0'), accession=accessionFor(cik);
    return { ticker,cik,accession,companyFacts:companyFactsFor(cik,index>=2),
      financialPeriods:[2024,2025].map(year=>({period_type:'annual',fiscal_period_end:`${year}-12-31`})),
      checkpoint:index===0?{accession,sourceIdentity:expectedSyntheticLegacy,schemaVersion:1}
        :index===1?{accession,sourceIdentity:expectedSyntheticSecondary,schemaVersion:1}
          :index===2?{accession,sourceIdentity:expectedSyntheticCompatLegacy,schemaVersion:1}:null,
      evidenceAsOf:null };
  });
}

export async function identityMessages(item) {
  const enqueuedAt='2026-10-06T00:00:00.000Z';
  const legacy=await buildCompactSecRawMessage({...item,enqueuedAt});
  const canonicalMessage=await buildDiscoveredMessage({approved:{ticker:item.ticker,cik:item.cik},candidate:{accession:item.accession},...item,enqueuedAt});
  return {legacy,canonicalMessage};
}

/** Producer/journal 경로에 주입하는 메모리 전용 fixture이며 외부 API나 실제 기업 자료를 쓰지 않는다. */
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
