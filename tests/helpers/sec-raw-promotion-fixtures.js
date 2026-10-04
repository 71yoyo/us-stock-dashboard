import { readdirSync } from 'node:fs';
import { createRawRuntimeDatabase } from './sec-standard-raw-runtime-db.js';
import { addFact,secFact } from './sec-standard-raw-fixtures.js';
import { extractStandardRawMetrics } from '../../worker/src/sec-standard-raw.js';
import { rawSourceIdentity } from '../../worker/src/sec-raw-message.js';
import { promotionHash,sourceBytesHash } from '../../scripts/sec-raw-promotion.mjs';

export const testCheckpoint='a'.repeat(40);
export const testAccession='0000726728-26-000001';
export const testTarget={databaseId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',name:'synthetic-r8b'};
export function sourceFixture({cash=10,review=false,accession=testAccession}={}) {
  const facts={};
  for(const [tag,val] of [['Revenues',100],['NetIncomeLoss',20],['CashAndCashEquivalentsAtCarryingValue',cash],['Assets',200]]) {
    addFact(facts,tag,secFact(/Cash|Assets/.test(tag)?null:'2025-01-01','2025-12-31',val,{accn:accession,
      ...(review && tag==='Assets'?{entityScope:'parent'}:{})}));
  }
  return {cik:726728,facts};
}
export function addMigrationLedger(ctx) {
  ctx.sqlite.exec('CREATE TABLE d1_migrations(name TEXT PRIMARY KEY)');
  for(const name of readdirSync(new URL('../../worker/migrations/',import.meta.url)).filter(name=>name.endsWith('.sql'))) {
    ctx.sqlite.prepare('INSERT INTO d1_migrations(name) VALUES (?)').run(name);
  }
}

/** DB/승인 정보 모두 합성값이다. 실제 credential/Production identity 파일을 만들지 않는다. */
export async function createPromotionFixture(options={}) {
  const ctx=createRawRuntimeDatabase();
  addMigrationLedger(ctx);
  ctx.sqlite.exec("INSERT INTO companies(ticker,name,cik) VALUES ('O','합성 검증','726728'); INSERT INTO financial_metrics(ticker,period_type,fiscal_period_end,source,revenue) VALUES ('O','annual','2025-12-31','SEC EDGAR',42)");
  ctx.DB.identity=async()=>({uuid:testTarget.databaseId,name:testTarget.name});
  const financialPeriods=[{period_type:'annual',fiscal_period_end:'2025-12-31'}];
  const companyFacts=sourceFixture(options),sourceBytes=JSON.stringify(companyFacts);
  const records=extractStandardRawMetrics(companyFacts.facts,{financialPeriods});
  const identity=await rawSourceIdentity({version:1,ticker:'O',accession:testAccession,cik:String(companyFacts.cik),facts:companyFacts.facts,financialPeriods});
  const envelope={approvalVersion:1,datasetVersion:'synthetic-r8b-v1',checkpoint:testCheckpoint,
    issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),target:{...testTarget},
    tickers:['O'],sourceHashes:{O:sourceBytesHash(sourceBytes)},ciks:{O:'726728'},periodAnchorHashes:{O:promotionHash(financialPeriods)},
    historicalSourceIdentities:{O:identity},historicalAccessions:{O:testAccession},expected:{raw:records.length,
      provenance:records.filter(row=>row.provenance).length,missing:records.filter(row=>row.availability==='missing').length,
      needsReview:records.filter(row=>row.availability==='needs_review').length},retentionExpected:{recovered:0,total:0},
    minimumMigration:22,writeBudget:50000,queue:{accountId:'a'.repeat(32),queueId:'b'.repeat(32),name:'synthetic-r8b-queue'}};
  const input={companyFacts,sourceBytes,financialPeriods};
  return {...ctx,envelope,input,records,options:{tickers:['O'],DB:ctx.DB,target:{...testTarget,allowedDatabaseId:testTarget.databaseId},
    loadCompanyFacts:async()=>input,envelope,checkpoint:testCheckpoint}};
}
