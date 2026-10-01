import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, stableData } from './specialized-disposable-db.mjs';
import { saveSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { verifyDocument } from './p75-document-verification.js';
import { acquireLease, renewLease, releaseLease, fenceStatement, fencedDatabase } from './specialized-import-coordination.mjs';
import { boundedRetry } from './p75-policy.js';
import { adminToken, createAdminDatabase } from './specialized-d1-admin.mjs';
import { parseArguments, loadImportArtifact } from './specialized-import-safety.mjs';
import { metricRecordKey } from '../worker/src/specialized-metrics.js';

export async function remoteSnapshot(DB, includeRows = false) {
  const arrays = [];
  for (const [table, order] of [['company_metric_definitions','metric_code,definition_owner,definition_version'],
    ['company_metric_values','record_key'], ['company_metric_sources','record_key,source_url,source_hash']]) {
    const rows = [];
    for (let offset = 0; ; offset += 100) {
      const page = (await DB.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT 100 OFFSET ?`).bind(offset).all()).results;
      rows.push(...page); if (page.length < 100) break;
    }
    arrays.push(rows);
  }
  arrays[1] = arrays[1].map(row => ({ ...row, validation_json: JSON.parse(row.validation_json) }));
  arrays[2] = arrays[2].map(row => ({ ...row, source_metadata_json: JSON.parse(row.source_metadata_json) }));
  const digests = Object.fromEntries(['definitions','values','provenance'].map((key,index) => [key,hash(stableData(arrays[index]))]));
  return { counts: { definitions: arrays[0].length, values: arrays[1].length, provenance: arrays[2].length },
    digests, digest: hash(digests), ...(includeRows ? { rows: arrays } : {}) };
}
export async function preflight(DB, identity, artifact) {
  const actual = await DB.identity();
  assert.equal(actual.uuid, identity.target_db_id, 'SAFE FAIL: 실제 DB ID 불일치');
  assert.equal(actual.name, identity.target_db_name, 'SAFE FAIL: 실제 DB name 불일치');
  const migrations = (await DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results;
  for (const number of ['0017_','0018_','0019_']) assert.ok(migrations.some(row => row.name.startsWith(number)), `필수 migration ${number} 미적용`);
  const names = (await DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map(row => row.name);
  for (const name of ['company_metric_definitions','company_metric_values','company_metric_sources',
    'specialized_import_registry','specialized_import_lease','specialized_import_guard']) assert.ok(names.includes(name), '필수 specialized schema 미확보');
  const registryRows = (await DB.prepare('SELECT * FROM specialized_import_registry').all()).results;
  // 이 최초 dataset importer는 다른 dataset과의 병합을 지원하지 않는다. 운영 확장 시 별도 정책 승인이 필요하다.
  assert.ok(registryRows.every(row => row.dataset_key === identity.dataset_key), '예상하지 못한 기존 dataset: STOP');
  const registry = registryRows[0] || null;
  if (registry) for (const [key,value] of Object.entries(identity)) assert.equal(registry[key], value, 'registry identity mismatch');
  const { rows, ...snapshot } = await remoteSnapshot(DB, true);
  const keys = new Set(artifact.documents.flatMap(document => document.records.map(metricRecordKey)));
  const definitions = new Set(artifact.documents.flatMap(document => document.definitions.map(row =>
    [row.metric_code,row.definition_owner,row.definition_version].join('|'))));
  const sources = new Set(artifact.documents.flatMap(document => document.records.flatMap(row => row.sources.map(source =>
    [metricRecordKey(row),source.source_url,source.source_hash].join('|')))));
  assert.ok(rows[0].every(row => definitions.has([row.metric_code,row.definition_owner,row.definition_version].join('|')))
    && rows[1].every(row => keys.has(row.record_key))
    && rows[2].every(row => sources.has([row.record_key,row.source_url,row.source_hash].join('|'))),
  '예상하지 못한 기존 specialized record/source: STOP');
  if (!registry) assert.ok(Object.values(snapshot.counts).every(count => count === 0), 'registry 없는 기존 specialized dataset: STOP');
  if (registry?.status === 'completed') assert.equal(snapshot.digest, artifact.expected.digest, '완료 dataset digest mismatch');
  return { registry, snapshot };
}
async function registryStart(DB, identity, lease) {
  const keys = Object.keys(identity);
  await DB.batch([fenceStatement(DB, lease), DB.prepare(`INSERT INTO specialized_import_registry
    (${keys.join(',')},status) VALUES(${keys.map(() => '?').join(',')},'running') ON CONFLICT(dataset_key)
    DO UPDATE SET status='running',completed_documents=0,last_document=NULL,attempts=specialized_import_registry.attempts+1,
    started_at=CURRENT_TIMESTAMP,completed_at=NULL,last_error=NULL,updated_at=CURRENT_TIMESTAMP`)
    .bind(...Object.values(identity)), fenceStatement(DB, lease)]);
}
export async function runImport(DB, options, artifact, identity, { onDocument = () => {} } = {}) {
  const checked = await preflight(DB, identity, artifact);
  if (options.verifyOnly || checked.registry?.status === 'completed') {
    if (checked.registry?.status === 'completed') for (const document of artifact.documents) await verifyDocument(DB, document);
    return { mode: 'verify-only', completed: checked.registry?.status === 'completed', ...checked.snapshot };
  }
  const lease = await acquireLease(DB, identity.dataset_key, randomUUID());
  if (!lease) throw new Error('lease denied: 다른 importer가 실행 중입니다.');
  try {
    // lock 획득 이전 preflight와 다른 writer의 completion 사이 race를 다시 확인한다.
    const locked = await preflight(DB, identity, artifact);
    if (locked.registry?.status === 'completed') return { mode: 'verify-only', completed: true, ...locked.snapshot };
    await registryStart(DB, identity, lease);
    for (const [index, document] of artifact.documents.entries()) {
      await renewLease(DB, lease);
      await boundedRetry(async attempt => {
        if (attempt) { await renewLease(DB, lease); if (DB.metrics) DB.metrics.retries++; }
        await saveSpecializedMetrics(fencedDatabase(DB, lease), { ...document, status: 'parsed' });
      });
      await verifyDocument(DB, document);
      await DB.batch([fenceStatement(DB, lease), DB.prepare(`UPDATE specialized_import_registry SET
        completed_documents=?,last_document=?,updated_at=CURRENT_TIMESTAMP WHERE dataset_key=?`)
        .bind(index + 1, document.id, identity.dataset_key), fenceStatement(DB, lease)]);
      await onDocument({ id: document.id, completed: index + 1 });
    }
    const final = await remoteSnapshot(DB);
    assert.deepEqual(final.counts, artifact.expected.counts);
    assert.equal(final.digest, artifact.expected.digest, 'full dataset digest mismatch');
    await DB.batch([fenceStatement(DB, lease), DB.prepare(`UPDATE specialized_import_registry SET
      status='completed',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE dataset_key=?`)
      .bind(identity.dataset_key), fenceStatement(DB, lease)]);
    return { mode: 'apply', completed: true, ...final };
  } catch (error) {
    // 에러 문자열 전체는 값/개인정보가 들어갈 수 있어 저장하지 않는다. 소유권 상실 시 다른 owner 상태도 변경하지 않는다.
    try { await DB.batch([fenceStatement(DB, lease), DB.prepare(`UPDATE specialized_import_registry SET
      status='failed',last_error='IMPORT_INTERRUPTED',updated_at=CURRENT_TIMESTAMP WHERE dataset_key=?`)
      .bind(identity.dataset_key), fenceStatement(DB, lease)]); } catch { /* takeover 이후 registry를 손대지 않는다. */ }
    throw error;
  } finally { await releaseLease(DB, lease); }
}
if (process.argv[1] === resolve('scripts/specialized-production-import.mjs')) {
  try {
    // 옵션/artifact 검사를 인증/원격 접속보다 먼저 한다. 기본 모드는 쓰기 권한 없는 adapter다.
    const options = parseArguments(process.argv.slice(2));
    const { artifact, identity } = loadImportArtifact(options);
    const DB = createAdminDatabase({ accountId: options.accountId || process.env.CLOUDFLARE_ACCOUNT_ID,
      dbId: options.dbId, token: adminToken(), allowWrite: Boolean(options.apply) });
    const result = await runImport(DB, options, artifact, identity);
    console.log(JSON.stringify({ ...result, metrics: DB.metrics }, null, 2));
  } catch (error) { console.error(`관리자 importer 중단: ${error.message}`); process.exitCode = 1; }
}
