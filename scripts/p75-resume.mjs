import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash, stableData } from './specialized-disposable-db.mjs';
import { assertDisposable, wrangler, rehearsalName } from './p75-prepare.mjs';
import { boundedRetry } from './p75-policy.js';
import { readApprovedArtifact } from './p75-artifact-check.mjs';

// 실제 remote 중간 실패 뒤 같은 artifact 전체를 다시 적재한다. production DB는 config guard가 차단한다.
assert.ok(process.argv.includes('--confirm-disposable'));
const configPath = resolve('backups/p75/config-18.json'); assertDisposable(JSON.parse(readFileSync(configPath)));
const artifact = readApprovedArtifact();
const requests = [], result = {};
async function call(path, input = {}) {
  const response = await fetch(`http://127.0.0.1:8795${path}`, { method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } });
  const body = await response.json(); requests.push({ path, id: input.document?.id, ...body });
  if (!body.ok) throw new Error(body.error);
  return body;
}
function sql(command) {
  return JSON.parse(wrangler(['d1', 'execute', rehearsalName, '--remote', '--config', configPath, '--json', '--command', command]));
}
function snapshot() {
  const data = sql('SELECT * FROM company_metric_definitions ORDER BY metric_code,definition_owner,definition_version; SELECT * FROM company_metric_values ORDER BY record_key; SELECT * FROM company_metric_sources ORDER BY record_key,source_url,source_hash;');
  const definitions = data[0].results, values = data[1].results.map(row => ({ ...row, validation_json: JSON.parse(row.validation_json) }));
  const sources = data[2].results.map(row => ({ ...row, source_metadata_json: JSON.parse(row.source_metadata_json) }));
  const digests = { definitions: hash(stableData(definitions)), values: hash(stableData(values)), provenance: hash(stableData(sources)) };
  return { counts: { definitions: definitions.length, values: values.length, provenance: sources.length }, digests, digest: hash(digests), meta: data.map(row => row.meta) };
}
const doc = row => ({ id: row.id, definitions: row.definitions, records: row.records });
try {
  result.profileRace = (await call('/profile-race')).result;
  assert.ok(result.profileRace.staleBackfillBlocked && result.profileRace.updatedProfilePreserved);
  const protectedQuery = 'SELECT * FROM financial_metrics ORDER BY ticker,period_type,fiscal_period_end; SELECT * FROM company_classification ORDER BY ticker;';
  const protectedBefore = hash(stableData(sql(protectedQuery).map(row => row.results.map(({ classified_at, ...value }) => value))));
  sql('DELETE FROM company_metric_sources; DELETE FROM company_metric_values; DELETE FROM company_metric_definitions;');
  const dataset = artifact.datasetVersion;
  const leases = await Promise.all(['P75_RACE_A', 'P75_RACE_B'].map(owner => call('/lease', { action: 'acquire', dataset, owner })));
  assert.equal(leases.filter(row => row.result).length, 1);
  const lease = leases.find(row => row.result).result;
  const denied = { ...lease, owner: lease.owner === 'P75_RACE_A' ? 'P75_RACE_B' : 'P75_RACE_A' };
  const concurrent = await Promise.allSettled([call('/import', { document: doc(artifact.documents[0]), lease }), call('/import', { document: doc(artifact.documents[0]), lease: denied })]);
  assert.equal(concurrent[0].status, 'fulfilled'); assert.equal(concurrent[1].status, 'rejected');
  assert.match(concurrent[1].reason.message, /lease denied/);
  result.concurrentImport = { writeOwner: 1, deniedBeforeStorePreflight: true };
  for (const row of artifact.documents.slice(1, 3)) await call('/import', { document: doc(row), lease });
  const beforeFailure = snapshot();
  await assert.rejects(() => call('/import', { document: doc(artifact.documents[3]), lease, injectFailure: true }), /CHECK constraint failed/);
  assert.equal(snapshot().digest, beforeFailure.digest);
  result.failureAtDocument4 = { prior3Preserved: true, atomicRollback: true };
  let lostResponseAttempts = 0;
  await boundedRetry(async () => {
    await call('/import', { document: doc(artifact.documents[0]), lease });
    if (++lostResponseAttempts === 1) throw new Error('network: synthetic lost response after remote commit');
  });
  assert.equal(snapshot().digest, beforeFailure.digest);
  result.retry = { syntheticResponseLoss: true, attempts: lostResponseAttempts, duplicateRows: 0 };
  const documents = [];
  for (const row of artifact.documents) {
    await call('/lease', { ...lease, action: 'renew' });
    const imported = await call('/import', { document: doc(row), lease });
    const verified = await call('/verify', { document: doc(row) });
    assert.equal(verified.result.readVerified, true); assert.equal(verified.metrics.rows_written, 0);
    documents.push({ id: row.id, ...imported.result, importMetrics: imported.metrics, verificationMetrics: verified.metrics });
    console.log(`Resume + SELECT verification ${row.id} PASS`);
  }
  result.final = snapshot(); assert.equal(result.final.digest, artifact.expected.digest);
  result.documents = documents;
  const conflict = doc(artifact.documents[0]); conflict.definitions = structuredClone(conflict.definitions);
  conflict.definitions[0].definition_notes += ' P75 SYNTHETIC CONFLICT';
  await assert.rejects(() => call('/import', { document: conflict, lease }), /정의 변경 금지/);
  assert.equal(snapshot().digest, result.final.digest);
  const protectedAfter = hash(stableData(sql(protectedQuery).map(row => row.results.map(({ classified_at, ...value }) => value))));
  assert.equal(protectedAfter, protectedBefore);
  result.protectedUnchanged = true;
  await call('/lease', { ...lease, action: 'release' });
} finally {
  result.requests = requests.length;
  result.usage = requests.reduce((sum, request) => {
    for (const key of ['sql', 'rpc', 'rows_read', 'rows_written', 'd1_duration_ms', 'wall_ms']) sum[key] = (sum[key] || 0) + (request.metrics?.[key] || 0);
    return sum;
  }, {});
  writeFileSync('backups/p75/resume-results.json', JSON.stringify(result, null, 2));
  writeFileSync('backups/p75/resume-requests.json', JSON.stringify(requests, null, 2));
}
