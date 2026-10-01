import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { adminToken,createAdminDatabase } from './specialized-d1-admin.mjs';
import { loadImportArtifact,validateOptions,TARGETS } from './specialized-import-safety.mjs';
import { remoteSnapshot,runImport } from './specialized-production-import.mjs';
import { acquireLease,renewLease,releaseLease,fencedDatabase } from './specialized-import-coordination.mjs';
import { backfillClassification } from '../worker/src/classification-backfill.js';
import { hash,stableData } from './specialized-disposable-db.mjs';
import { saveSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { querySpecializedMetrics } from '../worker/src/specialized-metric-query.js';

// 쓰기/초기화는 정확한 기존 disposable 이름 확인 없이는 절대 실행하지 않는다. 운영 분기 자체가 없다.
if (process.argv[1] === resolve('scripts/p76-remote-rehearsal.mjs')) {
  assert.deepEqual(process.argv.slice(2),['--confirm-rehearsal',TARGETS.rehearsal.name,'--reset-rehearsal'], '격리 DB reset 확인이 필요합니다.');
  const manifest=JSON.parse(readFileSync('backups/p75/manifest.json','utf8'));
  const options=validateOptions({rehearsal:true,dbId:TARGETS.rehearsal.id,dbName:TARGETS.rehearsal.name,
    expectedDbName:TARGETS.rehearsal.name,artifact:`backups/p75/${manifest.artifactFile}`,datasetVersion:manifest.datasetVersion,
    artifactSha256:manifest.artifactFileDigest,apply:true,confirmRehearsal:TARGETS.rehearsal.name});
  const {artifact,identity}=loadImportArtifact(options);
  const DB=createAdminDatabase({accountId:'3b11130d1e729d56312f9ae504becc60',dbId:options.dbId,token:adminToken(),allowWrite:true});
  const actual=await DB.identity(); assert.equal(actual.uuid,TARGETS.rehearsal.id);assert.equal(actual.name,TARGETS.rehearsal.name);
  const result={environment:'rehearsal',productionChanged:false,execution:'Node -> D1 REST /query batch'};
  const record=() => { mkdirSync('backups/p76',{recursive:true});writeFileSync('backups/p76/remote-results.json',JSON.stringify({...result,metrics:DB.metrics},null,2)); };
  try {
    const before=await remoteSnapshot(DB); assert.equal(before.digest,artifact.expected.digest);
    const tables=['company_metric_definitions','company_metric_values','company_metric_sources'];
    const backup={createdAt:new Date().toISOString(),dbId:actual.uuid,dbName:actual.name,snapshot:before,tables:{}};
    for(const table of tables) backup.tables[table]=(await DB.prepare(`SELECT * FROM ${table}`).all()).results;
    mkdirSync('backups/p76',{recursive:true});writeFileSync('backups/p76/disposable-before-reset.json',JSON.stringify(backup));
    const migrations=(await DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results;
    if(!migrations.some(row=>row.name.startsWith('0019_'))) {
      const statements=readFileSync('worker/migrations/0019_specialized_import_coordination.sql','utf8')
        .replace(/^\s*--.*$/gm,'').split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>DB.prepare(sql));
      await DB.batch([...statements,DB.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind('0019_specialized_import_coordination.sql')]);
    }
    result.migration19=true;record();
    // REST batch 원자성은 Worker batch 결과를 추측해 대신 쓰지 않고 실제 CHECK 실패로 재검증한다.
    const guardCount=await DB.prepare('SELECT COUNT(*) n FROM specialized_import_guard').first();
    await assert.rejects(()=>DB.batch([DB.prepare('INSERT INTO specialized_import_guard(id,ok) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET ok=1'),
      DB.prepare('INSERT INTO specialized_import_guard(id,ok) VALUES(1,0) ON CONFLICT(id) DO UPDATE SET ok=0')]),/CHECK/);
    assert.deepEqual(await DB.prepare('SELECT COUNT(*) n FROM specialized_import_guard').first(),guardCount);
    result.restAtomicRollback=true;
    const owners=await Promise.all([acquireLease(DB,identity.dataset_key,'P76_A'),acquireLease(DB,identity.dataset_key,'P76_B')]);
    assert.equal(owners.filter(Boolean).length,1);const winner=owners.find(Boolean);
    assert.equal((await renewLease(DB,winner)).fence,winner.fence);await releaseLease(DB,winner);
    const expired=await acquireLease(DB,identity.dataset_key,'P76_STALE',250);await delay(400);
    const current=await acquireLease(DB,identity.dataset_key,'P76_NEW');assert.ok(current.fence>expired.fence);
    await assert.rejects(()=>saveSpecializedMetrics(fencedDatabase(DB,expired),{...artifact.documents[0],status:'parsed'}),/CHECK/);
    assert.equal((await remoteSnapshot(DB)).digest,before.digest);
    // batch 중간 소유권이 바뀌어도 끝 guard가 앞선 SQL/lease 변경까지 되돌리는지 확인한다.
    await assert.rejects(()=>fencedDatabase(DB,current).batch([
      DB.prepare("UPDATE specialized_import_lease SET owner_token='P76_INJECTED',fence=fence+1 WHERE lock_key='specialized'")]),/CHECK/);
    assert.equal((await renewLease(DB,current)).fence,current.fence);await releaseLease(DB,current);
    result.lock={concurrentWinner:1,renew:true,release:true,expiryTakeover:true,staleBlocked:true,endFenceRollback:true};record();
    const financialBefore=hash(stableData((await DB.prepare('SELECT * FROM financial_metrics ORDER BY ticker,period_type,fiscal_period_end').all()).results));
    const original=await DB.prepare("SELECT ticker,sector,industry,cik FROM companies WHERE ticker='O'").first();
    const cas=await backfillClassification(DB,'O',{beforeWrite:async(_,attempt)=>{
      if(!attempt) await DB.prepare("UPDATE companies SET sector='Financial Services',industry='Banks - Regional',cik='P76_SYNTHETIC' WHERE ticker='O'").run();
    }});
    assert.equal(cas.attempts,2);const changed=await DB.prepare("SELECT * FROM company_classification WHERE ticker='O'").first();
    assert.equal(changed.auto_profile,'BANK');assert.equal(changed.company_cik,'P76_SYNTHETIC');
    await DB.prepare('UPDATE companies SET sector=?,industry=?,cik=? WHERE ticker=?').bind(original.sector,original.industry,original.cik,original.ticker).run();
    const classification=[];
    for(const company of (await DB.prepare('SELECT ticker FROM companies ORDER BY ticker').all()).results) classification.push(await backfillClassification(DB,company.ticker));
    result.classification={cas:true,changedMetadataRetries:cas.attempts,tickers:classification.length};record();
    // backup 확인 이후 정확한 disposable specialized/registry namespace만 초기화한다. 금융/분류 데이터는 보존한다.
    await DB.batch(['company_metric_sources','company_metric_values','company_metric_definitions','specialized_import_registry']
      .map(table=>DB.prepare(`DELETE FROM ${table}`)));
    result.verifyOnly=await runImport(DB,{verifyOnly:true},artifact,identity);assert.equal(result.verifyOnly.mode,'verify-only');
    result.run1=await runImport(DB,{verifyOnly:false},artifact,identity,{onDocument:({id,completed})=>{console.log(`P7.6 ${completed}/40 ${id} PASS`);}});record();
    const writesBefore=DB.metrics.rows_written;
    result.run2=await runImport(DB,{verifyOnly:false},artifact,identity);
    result.run2RowsWritten=DB.metrics.rows_written-writesBefore;assert.equal(result.run2RowsWritten,0);
    assert.equal(result.run1.digest,result.run2.digest);
    // full rerun 복구도 cursor skip 없이 모두 재처리한다. 완료 registry는 읽기 검증만 한다.
    await DB.prepare("UPDATE specialized_import_registry SET status='failed',completed_documents=3,last_document='2016-q3' WHERE dataset_key=?").bind(identity.dataset_key).run();
    result.fullRerun=await runImport(DB,{verifyOnly:false},artifact,identity);assert.equal(result.fullRerun.digest,result.run1.digest);record();
    const lease=await acquireLease(DB,identity.dataset_key,'P76_CONFLICT');
    const conflict=structuredClone(artifact.documents[0]);conflict.records[0].raw_value+=1;
    conflict.records[0].canonical_value=conflict.records[0].raw_value*conflict.records[0].raw_unit_multiplier;
    await assert.rejects(()=>saveSpecializedMetrics(fencedDatabase(DB,lease),{...conflict,status:'parsed'}),/충돌/);
    await releaseLease(DB,lease);result.conflictRejected=true;
    result.query={};
    for(const scope of ['quarterly','annual','ytd']) for(const metric of ['FFO','AFFO','NORMALIZED_FFO']) {
      const start=Date.now();const data=await querySpecializedMetrics(DB,{ticker:'O',metricCode:metric,periodScope:scope,valueBasis:'per_share',shareBasis:'diluted'});
      result.query[`${scope}:${metric}`]={count:data.data.length,wallMs:Date.now()-start,cpuMs:null};
    }
    assert.equal(hash(stableData((await DB.prepare('SELECT * FROM financial_metrics ORDER BY ticker,period_type,fiscal_period_end').all()).results)),financialBefore);
    result.financialUnchanged=true;result.final=await remoteSnapshot(DB);assert.equal(result.final.digest,artifact.expected.digest);
    result.complete=true;record();console.log(JSON.stringify({...result,metrics:DB.metrics},null,2));
  } catch(error) {result.error=error.message;record();throw error;}
}
