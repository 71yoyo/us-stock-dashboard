import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRawRuntimeDatabase } from '../tests/helpers/sec-standard-raw-runtime-db.js';
import { saveStandardRawMetrics } from '../worker/src/sec-standard-raw-store.js';
import { extractCompactRawRecords, runCompactRawRuntime, lookupIncrementalReviews } from '../worker/src/sec-standard-raw-incremental.js';

// R6H에서 확정한 실제 두 후보만 재사용한다. 외부 호출·원문 다운로드는 없다.
if (!existsSync('backups/r6f/local-input.json') || !existsSync('backups/r6f/worker.js')) {
  throw new Error('R6I 실제 후보 검증에는 기존 Git 제외 R6F/R6H 입력과 reference harness가 필요합니다. 새 원문을 받지 말고 기존 검증 환경에서 실행해 주세요.');
}
const { default: legacyHarness } = await import('../backups/r6f/worker.js');
const input=JSON.parse(readFileSync('backups/r6f/local-input.json','utf8'));
const snapshot=sqlite=>({ values:sqlite.prepare('SELECT * FROM sec_standard_raw_metrics ORDER BY metric_name,period_type,period_start,period_end').all(),
 provenance:sqlite.prepare('SELECT * FROM sec_standard_raw_provenance ORDER BY metric_name,period_type,period_start,period_end,source_fingerprint').all() });
const clean=rows=>rows.map(({created_at,updated_at,...row})=>row);
const result=[];
for(const item of input.selected){
 const before=createRawRuntimeDatabase(),after=createRawRuntimeDatabase();
 try{
  for(const db of [before,after]){
   db.sqlite.prepare('INSERT INTO companies(ticker,name) VALUES (?,?)').run(item.ticker,item.ticker);
   await saveStandardRawMetrics(db.DB,item.ticker,item.historical);
   db.sqlite.prepare(`INSERT INTO sec_raw_runtime(ticker,raw_status,raw_schema_version,raw_data_version,raw_last_accession,record_count,available_count)
    VALUES (?,'ready',1,2,?,?,?)`).run(item.ticker,item.historicalAccession,item.historical.length,item.analysis.historical.available);
  }
  const extracted=extractCompactRawRecords(item.compactFacts,item.accession,item.financial);
  assert.deepEqual(extracted,item.candidate);
  const token='local-test-only';
  const env={DB:before.DB,R6F_DB_ID:'de3f265c-d6ec-4561-8a53-64effad66eb5',R6F_EXPIRES_AT:String(Date.now()+60000),
   R6F_ALIASES:JSON.stringify([item.ticker]),R6F_AUTH_HASH:createHash('sha256').update(token).digest('hex')};
  const request=new Request('http://localhost/__r6f/run',{method:'POST',headers:{Authorization:`Bearer ${token}`,
   'Content-Type':'application/json','X-R6F-Probe':'local-r6i','X-R6F-Scenario':'I_COMPACT'},
   body:JSON.stringify({alias:item.ticker,accession:item.accession,financial:item.financial,facts:item.compactFacts})});
  const log=console.log;let old;
  try{console.log=()=>{};old=await (await legacyHarness.fetch(request,env)).json();}finally{console.log=log;}
  assert.ok(!old.exception);
  const newer=await runCompactRawRuntime({DB:after.DB,SEC_STANDARD_RAW_FIELDS_ENABLED:'true'},item.ticker,item.accession,
   async()=>({facts:item.compactFacts,financialPeriods:item.financial}));
  const a=snapshot(before.sqlite),b=snapshot(after.sqlite);
  assert.deepEqual(clean(a.values),clean(b.values));assert.deepEqual(clean(a.provenance),clean(b.provenance));
  for(const key of ['status','records','available','missing','needsReview','reviewCount','valueCorrections']) assert.equal(newer[key],old.result[key]);
  assert.equal(after.sqlite.prepare('SELECT raw_last_accession FROM sec_raw_runtime').get().raw_last_accession,item.historicalAccession);
  const reviews=await lookupIncrementalReviews(after.DB,item.ticker,extracted);
  assert.equal(reviews.length,item.analysis.missingPromotions);
  result.push({ticker:item.ticker,semanticEquality:'PASS',candidateRows:extracted.length,available:newer.available,
   missing:newer.missing,needsReview:newer.needsReview,review:newer.reviewCount,raw:a.values.length,provenance:a.provenance.length,
   accessionPreserved:true,DEIPreserved:extracted.filter(x=>x.metricName==='shares_outstanding'&&x.provenance?.secTag==='EntityCommonStockSharesOutstanding').map(x=>x.periodEnd)});
 }finally{before.sqlite.close();after.sqlite.close();}
}
writeFileSync('backups/r6i/local-semantics.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
