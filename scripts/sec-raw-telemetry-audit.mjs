import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createTelemetryTestDatabase} from '../tests/helpers/sec-raw-telemetry-db.js';
import {buildCompactSecRawMessage} from './sec-raw-compact-producer.mjs';
import consumer from '../worker/src/sec-raw-consumer-entry.js';

// 승인된 R4/R6F cache만 재사용한다. 실제 Queue·D1·Cloudflare 호출은 없으며 meta는 합성 fixture다.
const originalFetch=globalThis.fetch;
globalThis.fetch=()=>{throw Error('R9D-TEL audit 외부 호출 금지');};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const clean=rows=>rows.map(({updated_at,created_at,completed_at,raw_last_success_at,...row})=>row);
const snapshot=ctx=>JSON.stringify(['companies','financial_metrics','company_classification',
 'sec_standard_raw_metrics','sec_standard_raw_provenance','sec_raw_runtime','sec_raw_payload_checkpoint','sec_raw_runtime_guard']
 .map(table=>clean(ctx.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())));
const message=body=>({body,id:'local-queue-fixture',attempts:1,acks:0,retries:0,
 ack(){this.acks++;},retry(){this.retries++;}});
const captured=async operation=>{
 const previous=console.log,logs=[];console.log=item=>logs.push(item);
 try{return {result:await operation(),logs};}finally{console.log=previous;}
};
const results=[];
try{
 const ledger=JSON.parse(readFileSync('backups/r4/acquisition.json','utf8'));
 const selected=JSON.parse(readFileSync('backups/r6f/local-input.json','utf8')).selected;
 assert.deepEqual(selected.map(item=>item.ticker).sort(),['MSFT','O']);
 for(const item of selected){
  const bytes=readFileSync(`backups/r4/cache/${item.ticker}.json`);
  assert.equal(hash(bytes),ledger.find(source=>source.ticker===item.ticker).sourceSha256);
  const payload=await buildCompactSecRawMessage({ticker:item.ticker,accession:item.accession,
   companyFacts:JSON.parse(bytes),financialPeriods:item.financial});
  const off=createTelemetryTestDatabase(),on=createTelemetryTestDatabase();
  try{
   for(const ctx of [off,on])ctx.sqlite.prepare('INSERT INTO companies(ticker,name) VALUES (?,?)').run(item.ticker,item.ticker);
   const invoke=(ctx,flag)=>consumer.queue({messages:[message(payload)]},{DB:ctx.DB,
    SEC_STANDARD_RAW_QUEUE_ENABLED:'true',SEC_STANDARD_RAW_TELEMETRY_ENABLED:flag});
   const a=await captured(()=>invoke(off,'false')),b=await captured(()=>invoke(on,'true'));
   assert.equal(a.logs.length,0);assert.equal(b.logs.length,1);assert.deepEqual(a.result,b.result);
   assert.equal(snapshot(off),snapshot(on));assert.equal(off.totals.calls,on.totals.calls);
   assert.deepEqual(off.stats.map(row=>row.sql),on.stats.map(row=>row.sql));
   assert.equal(b.logs[0].d1Calls,on.totals.calls);assert.equal(b.logs[0].sqlStatements,on.stats.length);
   assert.equal(b.logs[0].rowsRead,on.totals.rowsRead);assert.equal(b.logs[0].rowsWritten,on.totals.rowsWritten);
   assert.equal(b.logs[0].d1DurationMs,on.totals.duration);
   assert.equal(b.logs[0].rawDelta,item.candidate.length);
   const firstCalls=on.totals.calls,firstStatements=on.stats.length,protectedBefore=snapshot(on);
   on.reset();const duplicate=await captured(()=>invoke(on,'true'));
   assert.equal(duplicate.result[0].status,'unchanged');assert.equal(duplicate.logs.length,1);
   assert.equal(duplicate.logs[0].rowsWritten,0);assert.equal(duplicate.logs[0].rawDelta,0);
   assert.equal(duplicate.logs[0].provenanceDelta,0);assert.equal(snapshot(on),protectedBefore);
   results.push({ticker:item.ticker,sourceHashVerified:true,semanticParity:'PASS',extraQueries:0,
    first:{raw:b.result[0].records,available:b.result[0].available,d1Calls:firstCalls,sqlStatements:firstStatements},
    duplicate:{status:'unchanged',d1Calls:on.totals.calls,rowsWritten:0,rawDelta:0,provenanceDelta:0},
    summaryCount:1,metaAggregation:'PASS'});
  }finally{off.sqlite.close();on.sqlite.close();}
 }
 console.log(JSON.stringify({phase:'R9D-TEL',status:'PASS',metaSource:'LOCAL SYNTHETIC FIXTURE — NOT BILLING/CPU MEASUREMENT',
  cpu:'NOT VERIFIED',productionD1Meta:'NOT VERIFIED',sourceCalls:0,productionChanged:false,results},null,2));
}finally{globalThis.fetch=originalFetch;}
