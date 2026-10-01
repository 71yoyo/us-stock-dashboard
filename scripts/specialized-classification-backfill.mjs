import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseArguments,loadImportArtifact } from './specialized-import-safety.mjs';
import { adminToken,createAdminDatabase } from './specialized-d1-admin.mjs';
import { backfillClassification } from '../worker/src/classification-backfill.js';

// 기존 production Worker를 먼저 배포하지 않고도 CAS backfill을 실행할 수 있는 별도 관리자 entry다.
export async function classifyStoredCompanies(DB,identity,apply=false) {
  const actual=await DB.identity();assert.equal(actual.uuid,identity.target_db_id);assert.equal(actual.name,identity.target_db_name);
  const migrations=(await DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results;
  assert.ok(migrations.some(row=>row.name.startsWith('0017_'))&&migrations.some(row=>row.name.startsWith('0019_')), '분류/coordination migration 미적용');
  const companies=(await DB.prepare('SELECT ticker,sector,industry,cik FROM companies ORDER BY ticker').all()).results;
  if(!apply) {
    const stored=(await DB.prepare('SELECT ticker,source_sector,source_industry,company_cik FROM company_classification ORDER BY ticker').all()).results;
    const optionalText=value=>typeof value==='string'&&value.trim()?value.trim():null;
    return {mode:'verify-only',companies:companies.length,staleOrMissing:companies.filter(company=>{
      const row=stored.find(row=>row.ticker===company.ticker);return !row||row.source_sector!==optionalText(company.sector)
        ||row.source_industry!==optionalText(company.industry)||row.company_cik!==company.cik;
    }).map(row=>row.ticker)};
  }
  const results=[];
  for(const company of companies) results.push(await backfillClassification(DB,company.ticker));
  return {mode:'apply',companies:companies.length,results};
}
if(process.argv[1]===resolve('scripts/specialized-classification-backfill.mjs')) {
  try {
    const options=parseArguments(process.argv.slice(2));const {identity}=loadImportArtifact(options);
    const DB=createAdminDatabase({accountId:options.accountId||process.env.CLOUDFLARE_ACCOUNT_ID,
      dbId:options.dbId,token:adminToken(),allowWrite:Boolean(options.apply)});
    console.log(JSON.stringify(await classifyStoredCompanies(DB,identity,Boolean(options.apply)),null,2));
  } catch(error){console.error(`분류 backfill 중단: ${error.message}`);process.exitCode=1;}
}
