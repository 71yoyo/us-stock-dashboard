import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetricTestDatabase,seedProtectedMetrics,protectedDigest } from './helpers/specialized-metrics-db.js';
import { officialResults } from './helpers/realty-income-fixtures.js';
import { saveSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { acquireLease, renewLease, releaseLease, fencedDatabase, DEFAULT_LEASE_MS } from '../scripts/specialized-import-coordination.mjs';
import { backfillClassification } from '../worker/src/classification-backfill.js';
import { classificationStatement, setManualClassification } from '../worker/src/company-classification.js';
import { validateOptions, parseArguments, TARGETS,loadImportArtifact,DATASET_KEY } from '../scripts/specialized-import-safety.mjs';
import { createAdminDatabase } from '../scripts/specialized-d1-admin.mjs';
import { runImport,remoteSnapshot } from '../scripts/specialized-production-import.mjs';
import { mkdtempSync,writeFileSync,rmSync,readFileSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import previewWorker from '../scripts/p76-query-worker.js';
import { classifyStoredCompanies } from '../scripts/specialized-classification-backfill.mjs';
import { backupPolicy } from '../scripts/specialized-release-policy.mjs';

const options = () => ({ ...TARGETS.rehearsal, dbId: TARGETS.rehearsal.id, dbName: TARGETS.rehearsal.name,
  expectedDbName: TARGETS.rehearsal.name, artifact: 'synthetic.json', datasetVersion: 'test', artifactSha256: 'a'.repeat(64), rehearsal: true });
for (const key of ['dbId','dbName','artifact','datasetVersion','artifactSha256','expectedDbName']) {
  test(`관리자 importer ${key} 누락은 SAFE FAIL`, () => { const value = options(); delete value[key]; assert.throws(() => validateOptions(value)); });
}
test('관리자 importer 기본은 verify-only이며 write에 confirmation이 필요하다', () => {
  assert.equal(validateOptions(options()).verifyOnly, true);
  assert.throws(() => validateOptions({ ...options(), apply: true }), /confirmation/);
  assert.equal(validateOptions({ ...options(), apply: true, confirmRehearsal: TARGETS.rehearsal.name }).verifyOnly, false);
  assert.throws(() => validateOptions({ ...options(), apply: true, verifyOnly: true }));
});
test('잘못된 DB ID/name 및 production/rehearsal 혼용은 차단한다', () => {
  for (const change of [{ dbId: TARGETS.production.id }, { dbName: TARGETS.production.name }, { expectedDbName: 'wrong' }, { rehearsal: false }]) {
    assert.throws(() => validateOptions({ ...options(), ...change }));
  }
  assert.throws(() => validateOptions({ ...options(), rehearsal: false, dbId: TARGETS.production.id,
    dbName: TARGETS.production.name, expectedDbName: TARGETS.production.name }), /승격/);
});
test('CLI 옵션 누락/중복/알 수 없는 flag는 원격 접속 전 차단한다', () => {
  for (const args of [[], ['--unsafe'], ['--db-id'], ['--apply','--apply']]) assert.throws(() => parseArguments(args));
});
test('0019는 additive-only이고 기존 0017/0018 테이블 숫자를 변경하지 않는다', () => {
  const { sqlite } = createMetricTestDatabase();
  try {
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'specialized_import_%'").get().n, 3);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM financial_metrics').get().n, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_values').get().n, 0);
  } finally { sqlite.close(); }
});
test('두 concurrent acquire 중 하나만 성공하고 active other owner는 거부한다', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    const leases = await Promise.all([acquireLease(DB,'dataset','one'), acquireLease(DB,'dataset','two')]);
    assert.equal(leases.filter(Boolean).length, 1);
    assert.equal(await acquireLease(DB,'different','third'), null);
    assert.ok(DEFAULT_LEASE_MS >= 60000);
  } finally { sqlite.close(); }
});
test('same owner renewal은 fence 유지, release/takeover는 fence 증가한다', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    const first = await acquireLease(DB,'dataset','one');
    assert.equal((await renewLease(DB,first)).fence, first.fence);
    await releaseLease(DB, first);
    const next = await acquireLease(DB,'dataset','two'); assert.equal(next.fence, first.fence + 1);
    assert.equal(await releaseLease(DB,first), null);
    await assert.rejects(() => renewLease(DB,first), /상실/);
  } finally { sqlite.close(); }
});
test('expiry takeover 후 stale batch는 guard row가 없어도 실제 SQL 전체 rollback된다', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    sqlite.exec("INSERT INTO companies(ticker,name) VALUES('O','P76 test')");
    const lease = await acquireLease(DB,'dataset','one');
    sqlite.exec("UPDATE specialized_import_lease SET expires_ms=0");
    const current = await acquireLease(DB,'dataset','two'); assert.ok(current.fence > lease.fence);
    await assert.rejects(async () => saveSpecializedMetrics(fencedDatabase(DB,lease), (await officialResults())[0]), /CHECK/);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_values').get().n, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_definitions').get().n, 0);
    await saveSpecializedMetrics(fencedDatabase(DB,current), (await officialResults())[0]);
    assert.ok(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_values').get().n > 0);
  } finally { sqlite.close(); }
});
test('metadata CAS가 sector/industry/CIK 변경을 재조회하며 manual override를 보존한다', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    const company = { ticker:'O',sector:'Real Estate',industry:'REIT - Retail',cik:'0000726728' };
    sqlite.prepare('INSERT INTO companies(ticker,name,sector,industry,cik) VALUES(?,?,?,?,?)')
      .run(company.ticker,'test',company.sector,company.industry,company.cik);
    await classificationStatement(DB,company).run();
    await setManualClassification({ DB },'O','GENERAL','테스트 override');
    const result = await backfillClassification(DB,'O',{ beforeWrite: async (_,attempt) => {
      if (!attempt) sqlite.exec("UPDATE companies SET sector='Financial Services',industry='Banks - Regional',cik='changed' WHERE ticker='O'");
    } });
    assert.equal(result.attempts,2);
    const row = sqlite.prepare("SELECT * FROM company_classification WHERE ticker='O'").get();
    assert.equal(row.auto_profile,'BANK'); assert.equal(row.effective_profile,'GENERAL'); assert.equal(row.company_cik,'changed');
  } finally { sqlite.close(); }
});
test('metadata CAS는 무한 재시도하지 않고 불안정한 입력을 안전 중단한다', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    sqlite.exec("INSERT INTO companies(ticker,name) VALUES('O','test')");
    await assert.rejects(() => backfillClassification(DB,'O',{ beforeWrite: async (_,attempt) => {
      sqlite.prepare("UPDATE companies SET cik=? WHERE ticker='O'").run(String(attempt));
    } }), /CHECK/);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_classification').get().n,0);
  } finally { sqlite.close(); }
});
test('관리자 REST adapter는 기본 write 차단, read-only 요청 body만 보낸다', async () => {
  let calls = 0;
  const DB = createAdminDatabase({ accountId:'a'.repeat(32),dbId:TARGETS.rehearsal.id,token:'synthetic',intervalMs:0,
    fetcher: async (_,request) => { calls++; const body=JSON.parse(request.body); assert.equal(body.batch[0].sql,'SELECT 1');
      return Response.json({success:true,result:[{success:true,results:[{one:1}],meta:{rows_written:0}}]}); } });
  assert.equal((await DB.prepare('SELECT 1').first()).one,1);
  await assert.rejects(() => DB.prepare('DELETE FROM companies').run(), /write 금지/);
  assert.equal(calls,1); assert.equal(DB.metrics.rows_written,0);
});
test('관리자 REST adapter는 bind/SQL size 제한을 네트워크 전에 검사한다', async () => {
  const DB=createAdminDatabase({accountId:'a'.repeat(32),dbId:TARGETS.rehearsal.id,token:'synthetic',intervalMs:0,
    fetcher:()=>{throw new Error('호출 금지');}});
  await assert.rejects(() => DB.prepare('SELECT 1').bind(...Array(101).fill(1)).all(), /제한/);
  await assert.rejects(() => DB.prepare('SELECT '+ 'a'.repeat(100000)).all(), /제한/);
});
test('artifact bytes hash와 parser/dataset identity가 다르면 원격 접속 전 중단한다', () => {
  const dir=mkdtempSync(join(tmpdir(),'p76-unit-'));
  try {
    const artifact=join(dir,'synthetic.json');const bytes=JSON.stringify({datasetVersion:'test',parserCommit:'wrong'});writeFileSync(artifact,bytes);
    assert.throws(()=>loadImportArtifact({...options(),artifact}),/hash mismatch/);
    const artifactSha256=createHash('sha256').update(bytes).digest('hex');
    assert.throws(()=>loadImportArtifact({...options(),artifact,artifactSha256,datasetVersion:'wrong'}),/identity mismatch/);
    assert.throws(()=>loadImportArtifact({...options(),artifact,artifactSha256}),/parser commit mismatch/);
  } finally {
    // Windows에서도 이번 테스트가 만든 Temp 하위 절대 경로임을 확인한 뒤에만 정리한다.
    const resolved=realpathSync(dir);
    assert.ok(resolved.startsWith(join(realpathSync(tmpdir()),'p76-unit-')));
    rmSync(resolved,{recursive:true,force:true});
  }
});
async function importerFixture() {
  const database=createMetricTestDatabase();const {sqlite,DB}=database;
  sqlite.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO d1_migrations VALUES(17,'0017_test'),(18,'0018_test'),(19,'0019_test'); INSERT INTO companies(ticker,name) VALUES('O','P76 synthetic')");
  DB.identity=async()=>({uuid:TARGETS.rehearsal.id,name:TARGETS.rehearsal.name});
  const document=(await officialResults())[0];await saveSpecializedMetrics(DB,document);
  const expected=await remoteSnapshot(DB);
  sqlite.exec('DELETE FROM company_metric_sources; DELETE FROM company_metric_values; DELETE FROM company_metric_definitions;');
  const artifact={documents:[{...document,id:'synthetic-document'}],expected};
  const identity={dataset_key:DATASET_KEY,dataset_version:'synthetic',target_db_id:TARGETS.rehearsal.id,
    target_db_name:TARGETS.rehearsal.name,target_environment:'rehearsal',artifact_sha256:'a'.repeat(64),
    semantic_digest:'b'.repeat(64),parser_commit:'synthetic'};
  return {...database,artifact,identity};
}
test('registry 완료 dataset는 Run2 apply 요청도 즉시 read-only 검증으로 전환한다', async () => {
  const {sqlite,DB,artifact,identity}=await importerFixture();
  try {
    const before=sqlite.prepare('SELECT total_changes() n').get().n;
    assert.equal((await runImport(DB,{verifyOnly:true},artifact,identity)).completed,false);
    assert.equal(sqlite.prepare('SELECT total_changes() n').get().n,before);
    const first=await runImport(DB,{verifyOnly:false},artifact,identity);
    const written=sqlite.prepare('SELECT total_changes() n').get().n;
    const second=await runImport(DB,{verifyOnly:false},artifact,identity);
    assert.equal(first.digest,second.digest);assert.equal(second.mode,'verify-only');
    assert.equal(sqlite.prepare('SELECT total_changes() n').get().n,written);
    assert.equal(sqlite.prepare('SELECT status FROM specialized_import_registry').get().status,'completed');
  } finally {sqlite.close();}
});
test('registry 없이 기존 specialized 값이 있으면 STOP, 실패 registry는 full rerun한다', async () => {
  const {sqlite,DB,artifact,identity}=await importerFixture();
  try {
    await saveSpecializedMetrics(DB,artifact.documents[0]);
    await assert.rejects(()=>runImport(DB,{verifyOnly:false},artifact,identity),/registry 없는/);
    sqlite.exec('DELETE FROM company_metric_sources; DELETE FROM company_metric_values; DELETE FROM company_metric_definitions;');
    await runImport(DB,{verifyOnly:false},artifact,identity);
    sqlite.exec("UPDATE specialized_import_registry SET status='failed',completed_documents=0");
    const rerun=await runImport(DB,{verifyOnly:false},artifact,identity);
    assert.equal(rerun.digest,artifact.expected.digest);
    assert.equal(sqlite.prepare('SELECT attempts FROM specialized_import_registry').get().attempts,2);
  } finally {sqlite.close();}
});
test('실제 DB identity/migration 누락/registry fingerprint 변경을 거부한다', async () => {
  const {sqlite,DB,artifact,identity}=await importerFixture();
  try {
    DB.identity=async()=>({uuid:TARGETS.production.id,name:TARGETS.production.name});
    await assert.rejects(()=>runImport(DB,{verifyOnly:true},artifact,identity),/실제 DB/);
    DB.identity=async()=>({uuid:TARGETS.rehearsal.id,name:TARGETS.rehearsal.name});
    sqlite.exec("DELETE FROM d1_migrations WHERE id=19");await assert.rejects(()=>runImport(DB,{verifyOnly:true},artifact,identity),/migration/);
    sqlite.exec("INSERT INTO d1_migrations VALUES(19,'0019_test')");await runImport(DB,{verifyOnly:false},artifact,identity);
    await assert.rejects(()=>runImport(DB,{verifyOnly:true},artifact,{...identity,artifact_sha256:'c'.repeat(64)}),/identity mismatch/);
  } finally {sqlite.close();}
});
test('private query harness는 운영 binding 및 공개 route/GET을 거부한다', async () => {
  assert.equal((await previewWorker.fetch(new Request('http://localhost/api/specialized'),{P76_LOCAL_ONLY:'YES'})).status,403);
  assert.equal((await previewWorker.fetch(new Request('http://localhost/__p76_query_probe',{method:'POST'}),{P76_LOCAL_ONLY:'YES',DB:{}})).status,403);
});
test('0019 existing migration은 재무 sentinel/분류 override/특화 값 전체를 보존한다', async () => {
  const {sqlite,DB}=createMetricTestDatabase(true,18);
  try {
    seedProtectedMetrics(sqlite);await saveSpecializedMetrics(DB,(await officialResults())[0]);
    const protectedBefore=protectedDigest(sqlite);const metricsBefore=await remoteSnapshot(DB);
    sqlite.exec(readFileSync('worker/migrations/0019_specialized_import_coordination.sql','utf8'));
    assert.equal(protectedDigest(sqlite),protectedBefore);assert.deepEqual(await remoteSnapshot(DB),metricsBefore);
  } finally {sqlite.close();}
});
test('별도 classification CLI 기본 검증은 쓰기 0이며 apply는 CAS로 stale 분류를 갱신한다', async () => {
  const {sqlite,DB,identity}=await importerFixture();
  try {
    const before=sqlite.prepare('SELECT total_changes() n').get().n;
    const verified=await classifyStoredCompanies(DB,identity);
    assert.deepEqual(verified.staleOrMissing,['O']);assert.equal(sqlite.prepare('SELECT total_changes() n').get().n,before);
    assert.equal((await classifyStoredCompanies(DB,identity,true)).results[0].metadataCas,true);
    assert.deepEqual((await classifyStoredCompanies(DB,identity)).staleOrMissing,[]);
  } finally {sqlite.close();}
});
test('main/feature branch도 연결된 Cloudflare 빌드를 실행하므로 백업 push 경로로 자동 승인하지 않는다', () => {
  const existing=JSON.parse(readFileSync('docs/realty-income-phase-p75-results.json','utf8')).autoDeploy;
  assert.equal(existing.pages.branch,'main');assert.equal(existing.pages.productionDeploymentsEnabled,true);
  assert.equal(backupPolicy({pagesPreviewAll:true,workerNonProductionBuilds:existing.worker.nonProductionBranchBuilds})
    .connectedRepositoryPushAllowed,false);
  assert.equal(backupPolicy({pagesPreviewAll:false,workerNonProductionBuilds:false}).connectedRepositoryPushAllowed,false);
});
