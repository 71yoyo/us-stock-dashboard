import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import consumer from '../worker/src/sec-raw-consumer-entry.js';
import { importHistoricalSecRaw,parseHistoricalArguments,assertHistoricalTarget } from '../scripts/sec-raw-historical-import.mjs';
import { validatePromotionEnvelope,verifyHistoricalPromotion,readOnlyDatabase,configuredProductionTargets,
  assertHistoricalScopeProcessed } from '../scripts/sec-raw-promotion.mjs';
import { createSecRawQueueTransport,queueTransportFailure } from '../scripts/sec-raw-queue-transport.mjs';
import { runSecRawDiscovery,parseDiscoveryArguments } from '../scripts/sec-raw-discovery-runner.mjs';
import { buildCompactSecRawMessage } from '../scripts/sec-raw-compact-producer.mjs';
import { createPromotionFixture,testCheckpoint,testAccession,sourceFixture } from './helpers/sec-raw-promotion-fixtures.js';

const changes=ctx=>ctx.stats.reduce((sum,row)=>sum+row.logicalChanges,0);
const clone=value=>structuredClone(value);
const rawState=ctx=>ctx.sqlite.prepare("SELECT * FROM sec_raw_runtime WHERE ticker='O'").get();
const receiptPair=async ctx=>{
  const verified=await verifyHistoricalPromotion(ctx.options);
  return {'verify-only':verified.receipt,'dry-run':{...verified.receipt,mode:'dry-run'}};
};
const approvedApply=async ctx=>importHistoricalSecRaw({...ctx.options,apply:true,enabled:true,
  productionApproval:true,evidence:await receiptPair(ctx)});
const compact=ctx=>buildCompactSecRawMessage({ticker:'O',accession:testAccession,companyFacts:ctx.input.companyFacts,
  financialPeriods:ctx.input.financialPeriods});
const transportOptions=ctx=>({accountId:ctx.envelope.queue.accountId,queueId:ctx.envelope.queue.queueId,
  queueName:ctx.envelope.queue.name,credential:'synthetic-test-only',DB:ctx.DB,envelope:ctx.envelope,checkpoint:testCheckpoint,
  enabled:true,dryRun:false});
const response=(status,result,success=status<300,errors=[])=>({status,ok:status>=200&&status<300,json:async()=>({success,result,errors})});
const metadata=ctx=>response(200,{queue_id:ctx.envelope.queue.queueId,queue_name:ctx.envelope.queue.name});

test('R8B verify-only는 identity/migration/source/CIK/anchors/count/raw state를 읽고 write 0',async()=>{
 const ctx=await createPromotionFixture();try{
  ctx.reset();const result=await importHistoricalSecRaw({...ctx.options,verifyOnly:true});
  assert.equal(result.mode,'verify-only');assert.deepEqual(result.counts,ctx.envelope.expected);
  assert.equal(changes(ctx),0);assert.ok(ctx.stats.every(row=>/^SELECT/.test(row.sql)));
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_raw_runtime').get().n,0);
 }finally{ctx.sqlite.close();}
});
test('R8B read-only adapter는 run/batch/multiple statements를 차단',async()=>{
 const ctx=await createPromotionFixture();try{
  const read=readOnlyDatabase(ctx.DB);assert.throws(()=>read.prepare('DELETE FROM companies'));
  assert.throws(()=>read.prepare('SELECT 1; DELETE FROM companies'));
  assert.throws(()=>read.prepare('SELECT 1').run());assert.throws(()=>read.batch([]));
 }finally{ctx.sqlite.close();}
});
test('R8B production target는 envelope/명시 승인 없으면 write 금지',async()=>{
 const ctx=await createPromotionFixture();try{
  const production=configuredProductionTargets()[0];ctx.reset();
  await assert.rejects(importHistoricalSecRaw({...ctx.options,envelope:null,target:{...production,allowedDatabaseId:production.databaseId},apply:true,enabled:true}));
  await assert.rejects(importHistoricalSecRaw({...ctx.options,apply:true,enabled:true}));
  assert.equal(changes(ctx),0);
 }finally{ctx.sqlite.close();}
});
test('R8B forged verification boolean/receipt로 기존 Production target guard 우회 불가',async()=>{
 const ctx=await createPromotionFixture();try{
  const production=configuredProductionTargets()[0];
  await assert.rejects(assertHistoricalTarget(ctx.DB,{...production,allowedDatabaseId:production.databaseId},
    {productionApproval:true,verifiedPromotion:true,verificationReceipt:{status:'PASS'}}));
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_metrics').get().n,0);
 }finally{ctx.sqlite.close();}
});

const mutations=[['checkpoint',e=>{e.checkpoint='b'.repeat(40);}],['expiration',e=>{e.expiresAt='2020-01-01T00:00:00Z';}],
 ['version',e=>{e.approvalVersion=2;}],['target id',e=>{e.target.databaseId='bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';}],
 ['target name',e=>{e.target.name='wrong';}],['ticker scope',e=>{e.tickers=['LMT'];}],
 ['source hash',e=>{e.sourceHashes.O='c'.repeat(64);}],['CIK',e=>{e.ciks.O='123';}],
 ['anchors',e=>{e.periodAnchorHashes.O='d'.repeat(64);}],['source identity',e=>{e.historicalSourceIdentities.O='e'.repeat(64);}],
 ['accession',e=>{e.historicalAccessions.O='0000726728-25-000001';}],['expected',e=>{e.expected.raw++;e.expected.missing++;}],
 ['minimum migration',e=>{e.minimumMigration=23;}],['budget',e=>{e.writeBudget=1;}],['extra secret field',e=>{e.credential='synthetic-forbidden';}]];
for(const [label,mutate] of mutations)test(`R8B ${label} 불일치는 apply 전에 STOP/write 0`,async()=>{
 const ctx=await createPromotionFixture();try{
  const evidence=await receiptPair(ctx),envelope=clone(ctx.envelope);mutate(envelope);ctx.reset();
  await assert.rejects(importHistoricalSecRaw({...ctx.options,envelope,evidence,apply:true,enabled:true,productionApproval:true}));
  assert.equal(changes(ctx),0);assert.equal(rawState(ctx),undefined);
 }finally{ctx.sqlite.close();}
});
for(const field of ['dry-run','verify-only'])test(`R8B ${field} 선행 evidence 없으면 write 금지`,async()=>{
 const ctx=await createPromotionFixture();try{
  const evidence=await receiptPair(ctx);delete evidence[field];ctx.reset();
  await assert.rejects(importHistoricalSecRaw({...ctx.options,evidence,apply:true,enabled:true,productionApproval:true}));assert.equal(changes(ctx),0);
 }finally{ctx.sqlite.close();}
});
test('R8B evidence 만료/대상 DB 상태 변경/loader bytes 변조 모두 차단',async()=>{
 const ctx=await createPromotionFixture();try{
  const evidence=await receiptPair(ctx);evidence['dry-run'].issuedAt='2020-01-01T00:00:00Z';
  await assert.rejects(importHistoricalSecRaw({...ctx.options,evidence,apply:true,enabled:true,productionApproval:true}));
  const fresh=await receiptPair(ctx);ctx.sqlite.exec("INSERT INTO sec_raw_runtime(ticker) VALUES ('O')");ctx.reset();
  await assert.rejects(importHistoricalSecRaw({...ctx.options,evidence:fresh,apply:true,enabled:true,productionApproval:true}));assert.equal(changes(ctx),0);
  ctx.input.sourceBytes+=' ';await assert.rejects(verifyHistoricalPromotion(ctx.options));
 }finally{ctx.sqlite.close();}
});
test('R8B DB raw 값 변경은 count가 같아도 evidence 재검증에서 차단',async()=>{
 const ctx=await createPromotionFixture();try{
  await approvedApply(ctx);const evidence=await receiptPair(ctx);
  ctx.sqlite.exec("UPDATE sec_standard_raw_metrics SET metric_value=metric_value+1 WHERE availability='available'");
  ctx.reset();await assert.rejects(importHistoricalSecRaw({...ctx.options,evidence,apply:true,enabled:true,productionApproval:true}),/EVIDENCE/);
  assert.equal(changes(ctx),0);
 }finally{ctx.sqlite.close();}
});
test('R8B 뒤 종목 source 오류도 앞 종목을 쓰기 전에 전 scope STOP',async()=>{
 const ctx=await createPromotionFixture();try{
  const envelope=clone(ctx.envelope);envelope.tickers.push('MSFT');
  for(const field of ['sourceHashes','ciks','periodAnchorHashes','historicalAccessions'])envelope[field].MSFT=envelope[field].O;
  const {rawSourceIdentity}=await import('../worker/src/sec-raw-message.js');
  envelope.historicalSourceIdentities.MSFT=await rawSourceIdentity({version:1,ticker:'MSFT',accession:testAccession,
    cik:'726728',facts:ctx.input.companyFacts.facts,financialPeriods:ctx.input.financialPeriods});
  for(const key of Object.keys(envelope.expected))envelope.expected[key]*=2;
  ctx.sqlite.exec("INSERT INTO companies(ticker,name,cik) VALUES ('MSFT','합성 scope 검증','726728'); INSERT INTO financial_metrics(ticker,period_type,fiscal_period_end,source,revenue) VALUES ('MSFT','annual','2025-12-31','SEC EDGAR',42)");
  ctx.reset();await assert.rejects(importHistoricalSecRaw({...ctx.options,tickers:envelope.tickers,envelope,
    loadCompanyFacts:async ticker=>ticker==='O'?ctx.input:{...ctx.input,sourceBytes:ctx.input.sourceBytes+' '},
    apply:true,enabled:true,productionApproval:true}),/SOURCE_HASH/);
  assert.equal(changes(ctx),0);assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_raw_runtime').get().n,0);
 }finally{ctx.sqlite.close();}
});
test('R8B dry-run receipt 후 explicit apply는 승인된 합성 DB에서만 가능',async()=>{
 const ctx=await createPromotionFixture();try{
  const dry=await importHistoricalSecRaw({...ctx.options});assert.equal(dry.mode,'dry-run');
  const verify=await importHistoricalSecRaw({...ctx.options,verifyOnly:true});
  const run=await importHistoricalSecRaw({...ctx.options,apply:true,enabled:true,productionApproval:true,
    evidence:{'dry-run':dry.receipt,'verify-only':verify.receipt}});
  assert.equal(run.results[0].status,'ready');
 }finally{ctx.sqlite.close();}
});
test('R8B review source checkpoint 허용, pending/NULL 유지, Run2 모든 logical write 0',async()=>{
 const ctx=await createPromotionFixture({review:true});try{
  const first=await approvedApply(ctx);assert.equal(first.results[0].status,'pending_review');
  assert.equal(rawState(ctx).raw_status,'pending');assert.equal(rawState(ctx).raw_last_accession,null);
  assert.ok(ctx.sqlite.prepare("SELECT COUNT(*) n FROM sec_standard_raw_metrics WHERE availability='needs_review' AND metric_value IS NULL").get().n>0);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM sec_raw_payload_checkpoint WHERE channel='historical'").get().n,1);
  const before=JSON.stringify(rawState(ctx));const evidence=await receiptPair(ctx);ctx.reset();
  const second=await importHistoricalSecRaw({...ctx.options,evidence,apply:true,enabled:true,productionApproval:true});
  assert.equal(second.results[0].status,'unchanged');assert.equal(second.results[0].reviewPending,true);
  assert.equal(changes(ctx),0);assert.ok(ctx.stats.every(row=>/^SELECT/.test(row.sql)));
  assert.equal(JSON.stringify(rawState(ctx)),before);await assertHistoricalScopeProcessed(ctx.DB,ctx.envelope);
 }finally{ctx.sqlite.close();}
});
test('R8B changed historical payload는 review 후 checkpoint 갱신, 동일 identity만 skip',async()=>{
 const ctx=await createPromotionFixture();try{
  const base={...ctx.options,envelope:null};await importHistoricalSecRaw({...base,apply:true,enabled:true});
  const previous=ctx.sqlite.prepare('SELECT source_identity FROM sec_raw_payload_checkpoint').get().source_identity;
  const companyFacts=sourceFixture({cash:11});const loadCompanyFacts=async()=>({companyFacts,financialPeriods:ctx.input.financialPeriods});
  const result=await importHistoricalSecRaw({...base,loadCompanyFacts,apply:true,enabled:true});
  assert.equal(result.results[0].status,'pending_review');assert.notEqual(ctx.sqlite.prepare('SELECT source_identity FROM sec_raw_payload_checkpoint').get().source_identity,previous);
  assert.equal(ctx.sqlite.prepare("SELECT metric_value FROM sec_standard_raw_metrics WHERE metric_name='cash_and_cash_equivalents'").get().metric_value,10);
  ctx.reset();assert.equal((await importHistoricalSecRaw({...base,loadCompanyFacts,apply:true,enabled:true})).results[0].status,'unchanged');assert.equal(changes(ctx),0);
 }finally{ctx.sqlite.close();}
});
test('R8B historical checkpoint 실패 시 raw/provenance rollback, 성공 처리 금지',async()=>{
 const ctx=await createPromotionFixture({review:true});try{
  ctx.sqlite.exec("CREATE TRIGGER fail_r8b BEFORE INSERT ON sec_raw_payload_checkpoint BEGIN SELECT RAISE(ABORT,'TEST'); END");
  assert.equal((await approvedApply(ctx)).results[0].status,'error');
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_metrics').get().n,0);
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_provenance').get().n,0);
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM sec_raw_payload_checkpoint').get().n,0);
 }finally{ctx.sqlite.close();}
});
test('R8B queue-only는 fetch/scheduled 없음, legacy fields OFF여도 독립 처리',async()=>{
 const ctx=await createPromotionFixture();try{
  assert.deepEqual(Object.keys(consumer),['queue']);assert.equal(consumer.fetch,undefined);assert.equal(consumer.scheduled,undefined);
  const message={body:await compact(ctx),ack(){},retry(){}};ctx.reset();
  assert.equal((await consumer.queue({messages:[message]},{DB:ctx.DB}))[0].status,'disabled');assert.equal(ctx.stats.length,0);
  const env={DB:ctx.DB,SEC_STANDARD_RAW_QUEUE_ENABLED:'true',SEC_STANDARD_RAW_FIELDS_ENABLED:'false'};
  assert.equal((await consumer.queue({messages:[message]},env))[0].status,'ready');assert.equal(env.SEC_STANDARD_RAW_FIELDS_ENABLED,'false');
 }finally{ctx.sqlite.close();}
});
test('R8B esbuild import graph에 HTTP/Cron/full runtime/Node/UI 없음',async()=>{
 const bundle=await build({entryPoints:['worker/src/sec-raw-consumer-entry.js'],bundle:true,write:false,format:'esm',platform:'browser',metafile:true});
 const inputs=Object.keys(bundle.metafile.inputs).join('\n'),code=bundle.outputFiles[0].text;
 assert.doesNotMatch(inputs,/fmp-sync|fundamental-sync|sec-standard-raw-runtime\.js|scripts\/|app\.js|index\.js/);
 assert.doesNotMatch(code,/runStandardRawRuntime|syncFinancialsFromSec|runFundamentalBatch|async scheduled|async fetch/);
 assert.match(code,/extractCompactRawRecords/);
});
test('R8B 추가 migration 없이 기존 schema로 processing/review 분리',()=>{
 const sql=readFileSync(new URL('../worker/migrations/0022_sec_raw_payload_checkpoint.sql',import.meta.url),'utf8');
 assert.match(sql,/channel IN\s*\('historical','compact'\)/);
});
test('R8B importer CLI verify-only/approval/evidence, discovery ticker/list/one-shot 지원',()=>{
 const parsed=parseHistoricalArguments(['--ticker','O','--cache-dir','local','--verify-only','--approval-file','backups/example.json']);
 assert.equal(parsed.verifyOnly,true);assert.equal(parsed.apply,false);
 const args=['--tickers','O,MSFT','--manifest','backups/example.json','--cache-dir','local','--credential-file','ignored'];
 assert.equal(parseDiscoveryArguments(args).dryRun,true);assert.equal(parseDiscoveryArguments([...args,'--detect-only']).detectOnly,true);
 assert.equal(parseDiscoveryArguments([...args,'--enqueue-enabled','--one-shot']).enqueueEnabled,true);
});

for(const status of [200,201,202,401,403,404,429,500,503])test(`R8B Queue transport HTTP ${status}: 고정 오류/retry 상한`,async()=>{
 const ctx=await createPromotionFixture();try{
  await approvedApply(ctx);let calls=0,sleeps=0;
  const fetchImpl=async(url,init)=>{
    assert.equal(init.headers.Authorization,'Bearer synthetic-test-only');
    if(init.method==='GET')return metadata(ctx);
    calls++;assert.deepEqual(Object.keys(JSON.parse(init.body)),['body','content_type']);
    assert.equal(JSON.parse(init.body).content_type,'json');
    return response(status,{},status<300,status>=300?[{code:10001,message:'MUST_NOT_ESCAPE'}]:[]);
  };
  const transport=createSecRawQueueTransport({...transportOptions(ctx),fetchImpl,maxRetries:1,sleep:async()=>{sleeps++;}});
  if(status<300)assert.equal((await transport.send(await compact(ctx))).status,'queued');
  else await assert.rejects(transport.send(await compact(ctx)),error=>{
    assert.equal(error.status,status);assert.deepEqual(error.cloudflareCodes,[10001]);
    const log=queueTransportFailure(error);assert.equal(log.httpStatus,status);assert.deepEqual(log.cloudflareCodes,[10001]);
    assert.doesNotMatch(JSON.stringify(log),/MUST_NOT_ESCAPE|synthetic-test-only/);
    assert.doesNotMatch(error.message,/MUST_NOT_ESCAPE|synthetic-test-only/);return true;
  });
  assert.equal(calls,status===429||status>=500?2:1);assert.equal(sleeps,status===429||status>=500?1:0);
 }finally{ctx.sqlite.close();}
});
test('R8B Queue disabled/dry-run: network/DB writes 0',async()=>{
 const ctx=await createPromotionFixture();try{
  let calls=0;const transport=createSecRawQueueTransport({...transportOptions(ctx),enabled:false,fetchImpl:async()=>{calls++;}});
  ctx.reset();assert.equal((await transport.send(await compact(ctx))).status,'dry-run');assert.equal(calls,0);assert.equal(ctx.stats.length,0);
 }finally{ctx.sqlite.close();}
});
test('R8B Queue timeout/invalid response/network: no silent retry',async()=>{
 const ctx=await createPromotionFixture();try{
  await approvedApply(ctx);
  for(const code of ['TIMEOUT_AMBIGUOUS','INVALID_RESPONSE','NETWORK_AMBIGUOUS']) {
   let calls=0;const fetchImpl=async(url,init)=>{
    if(init.method==='GET')return metadata(ctx);calls++;
    if(code==='TIMEOUT_AMBIGUOUS')return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('MUST_NOT_ESCAPE'))));
    if(code==='INVALID_RESPONSE')return {ok:true,status:200,json:async()=>{throw new Error('MUST_NOT_ESCAPE');}};
    throw new Error('MUST_NOT_ESCAPE');
   };
   await assert.rejects(createSecRawQueueTransport({...transportOptions(ctx),timeoutMs:5,maxRetries:2,fetchImpl}).send(await compact(ctx)),error=>error.code===code);
   assert.equal(calls,1);
  }
 }finally{ctx.sqlite.close();}
});
test('R8B Queue unknown success response/remote identity mismatch 거부',async()=>{
 const ctx=await createPromotionFixture();try{
  await approvedApply(ctx);
  await assert.rejects(createSecRawQueueTransport({...transportOptions(ctx),fetchImpl:async()=>response(200,{queue_id:'wrong',queue_name:'wrong'})}).send(await compact(ctx)),/REMOTE_IDENTITY/);
  await assert.rejects(createSecRawQueueTransport({...transportOptions(ctx),fetchImpl:async(url,init)=>init.method==='GET'?metadata(ctx):response(200,{},false)}).send(await compact(ctx)),/HTTP/);
 }finally{ctx.sqlite.close();}
});
test('R8B malformed payload/미승인 LMT/wrongQueue는 network 전에 거부',async()=>{
 const ctx=await createPromotionFixture();try{
  let calls=0;const transport=createSecRawQueueTransport({...transportOptions(ctx),fetchImpl:async()=>{calls++;}});
  await assert.rejects(transport.send({}));
  const lmt=await buildCompactSecRawMessage({ticker:'LMT',accession:testAccession,companyFacts:ctx.input.companyFacts});
  await assert.rejects(transport.send(lmt),/SCOPE/);
  await assert.rejects(createSecRawQueueTransport({...transportOptions(ctx),queueName:'wrong'}).send(await compact(ctx)),/IDENTITY/);
  assert.equal(calls,0);
 }finally{ctx.sqlite.close();}
});
test('R8B historical source 미처리/불일치/raw 누락이면 enqueue 불가',async()=>{
 const ctx=await createPromotionFixture();try{
  await assert.rejects(assertHistoricalScopeProcessed(ctx.DB,ctx.envelope),/HISTORY_NOT_PROCESSED/);
  await approvedApply(ctx);await assertHistoricalScopeProcessed(ctx.DB,ctx.envelope);
  ctx.sqlite.exec("UPDATE sec_raw_payload_checkpoint SET source_identity=replace(source_identity,'a','b')");
  // 우연히 hash가 바뀌지 않는 경우를 피하려고 고정 불일치값을 사용한다.
  ctx.sqlite.prepare('UPDATE sec_raw_payload_checkpoint SET source_identity=?').run('f'.repeat(64));
  await assert.rejects(assertHistoricalScopeProcessed(ctx.DB,ctx.envelope),/HISTORY_IDENTITY/);
  ctx.sqlite.prepare('UPDATE sec_raw_payload_checkpoint SET source_identity=?').run(ctx.envelope.historicalSourceIdentities.O);
  ctx.sqlite.exec('DELETE FROM sec_standard_raw_provenance');
  await assert.rejects(assertHistoricalScopeProcessed(ctx.DB,ctx.envelope),/HISTORY_INTEGRITY/);
 }finally{ctx.sqlite.close();}
});
test('R8B scope 중 하나라도 history 미완료면 다른 ticker도 enqueue 금지',async()=>{
 const ctx=await createPromotionFixture();try{
  await approvedApply(ctx);
  const envelope=clone(ctx.envelope);envelope.tickers.push('MSFT');
  await assert.rejects(assertHistoricalScopeProcessed(ctx.DB,envelope),/HISTORY_NOT_PROCESSED/);
 }finally{ctx.sqlite.close();}
});
test('R8B Node discovery detect/dryrun/enqueue/unchanged, LMT 거부',async()=>{
 const ctx=await createPromotionFixture();try{
  let calls=0;const options={...ctx.options,oneShot:true,transport:{send:async()=>{calls++;return {status:'queued'};}}};
  assert.equal((await runSecRawDiscovery({...options,detectOnly:true})).results[0].status,'detected');assert.equal(calls,0);
  assert.equal((await runSecRawDiscovery(options)).results[0].status,'dry-run');assert.equal(calls,0);
  await assert.rejects(runSecRawDiscovery({...options,enqueueEnabled:true,dryRun:false}),/HISTORY_NOT_PROCESSED/);
  await approvedApply(ctx);assert.equal((await runSecRawDiscovery({...options,enqueueEnabled:true,dryRun:false})).results[0].status,'queued');assert.equal(calls,1);
  await assert.rejects(runSecRawDiscovery({...options,tickers:['LMT']}),/SCOPE/);
  const message=await compact(ctx);await consumer.queue({messages:[{body:message,ack(){},retry(){}}]},
    {DB:ctx.DB,SEC_STANDARD_RAW_QUEUE_ENABLED:'true'});
  assert.equal((await runSecRawDiscovery(options)).results[0].status,'unchanged');
 }finally{ctx.sqlite.close();}
});
