import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash, stableData } from './specialized-disposable-db.mjs';
import { assertDisposable, wrangler, rehearsalName, output } from './p75-prepare.mjs';
import { metricRecordKey } from '../worker/src/specialized-metrics.js';
import { boundedRetry } from './p75-policy.js';
import { readApprovedArtifact } from './p75-artifact-check.mjs';

const configPath = resolve('backups/p75/config-18.json');
const config = JSON.parse(readFileSync(configPath)); assertDisposable(config);
assert.ok(process.argv.includes('--confirm-disposable'), 'remote rehearsal 확인 flag가 필요합니다.');
const artifact = readApprovedArtifact();
const requests = [];
// 네트워크/일시 과부하만 제한적으로 재시도한다. 의미 오류와 lease loss는 즉시 멈춘다.
async function call(path, input = {}) {
  return boundedRetry(async attempt => {
    const start = Date.now();
    const response = await fetch(`http://127.0.0.1:8795${path}`, { method: 'POST', body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000) });
    const body = await response.json();
    requests.push({ path, document: input.document?.id || null, http: response.status,
      ok: body.ok, error: body.error, metrics: body.metrics, attempt, latency_ms: Date.now() - start });
    writeFileSync('backups/p75/requests.json', JSON.stringify(requests, null, 2));
    if (!body.ok) { const error = new Error(body.error); error.response = body; throw error; }
    return body;
  });
}
async function snapshot() {
  const arrays = [];
  for (const table of ['company_metric_definitions', 'company_metric_values', 'company_metric_sources']) {
    const rows = [];
    for (let offset = 0; ; offset += 100) {
      const response = await call('/snapshot', { table, offset }); rows.push(...response.result);
      if (response.result.length < 100) break;
    }
    arrays.push(rows);
  }
  arrays[1] = arrays[1].map(row => ({ ...row, validation_json: JSON.parse(row.validation_json) }));
  arrays[2] = arrays[2].map(row => ({ ...row, source_metadata_json: JSON.parse(row.source_metadata_json) }));
  const digests = { definitions: hash(stableData(arrays[0])), values: hash(stableData(arrays[1])), provenance: hash(stableData(arrays[2])) };
  return { counts: { definitions: arrays[0].length, values: arrays[1].length, provenance: arrays[2].length }, digests, digest: hash(digests), arrays };
}
function clearSpecialized() {
  // 이 경로는 이미 검증된 전용 config만 받는다. 과거 운영 데이터에는 접근할 수 없다.
  return wrangler(['d1', 'execute', rehearsalName, '--remote', '--config', configPath, '--json', '--command',
    'DELETE FROM company_metric_sources; DELETE FROM company_metric_values; DELETE FROM company_metric_definitions;']);
}
const asDocument = row => ({ id: row.id, definitions: row.definitions, records: row.records });
const totalStatements = row => row.definitions.length + row.records.reduce((sum, record) => sum + 1 + record.sources.length, 0);
const maximum = [...artifact.documents].sort((a, b) => totalStatements(b) - totalStatements(a))[0];
const result = {};
try {
  if (process.argv.includes('--original')) {
    const production = await (await fetch('https://us-stock-dashboard-api.771yoyo.workers.dev/api/companies')).json();
    const companies = production.companies.map(({ ticker, name, sector, industry }) => ({ ticker, name, sector, industry, cik: ticker === 'O' ? '0000726728' : null }));
    const first = await call('/classify', { companies });
    assert.equal(first.result.length, 10);
    const profileMap = Object.fromEntries(first.result.map(row => [row.ticker, row.effective_profile]));
    assert.equal(profileMap.O, 'REIT'); assert.equal(profileMap.JPM, 'BANK');
    assert.equal(Object.values(profileMap).filter(profile => profile === 'GENERAL').length, 8);
    const second = await call('/classify');
    const semanticProfiles = rows => stableData(rows.map(({ classified_at, ...row }) => row));
    assert.deepEqual(semanticProfiles(second.result), semanticProfiles(first.result));
    const overridden = await call('/classify', { override: { ticker: 'O', profile: 'GENERAL' } });
    assert.equal(overridden.result.find(row => row.ticker === 'O').manual_override, 'GENERAL');
    const restored = await call('/classify', { override: { ticker: 'O', profile: null } });
    assert.equal(restored.result.find(row => row.ticker === 'O').effective_profile, 'REIT');
    result.classification = { rows: 10, profiles: profileMap, run2: true, overridePreserved: true };
    try { result.original = await call('/import', { document: asDocument(maximum) }); }
    catch (error) { result.original = error.response || { error: error.message }; }
    try { result.probe = await call('/probe', { reads: 60 }); }
    catch (error) { result.probe = error.response || { error: error.message }; }
    writeFileSync('backups/p75/original.json', JSON.stringify({ ...result, maximum: maximum.id, expectedBatch: totalStatements(maximum) }, null, 2));
  } else {
    clearSpecialized();
    const dataset = artifact.datasetVersion;
    const a = { dataset, owner: 'P75_OWNER_A' }, b = { dataset, owner: 'P75_OWNER_B' };
    const simultaneous = await Promise.all([call('/lease', { ...a, action: 'acquire' }), call('/lease', { ...b, action: 'acquire' })]);
    assert.equal(simultaneous.filter(response => response.result).length, 1);
    const winner = simultaneous.find(response => response.result).result;
    result.concurrent = { owners: 2, granted: 1, denied: 1 };
    await call('/lease', { ...winner, action: 'release' });
    const leaseA = (await call('/lease', { ...a, ttl: 500, action: 'acquire' })).result;
    await new Promise(done => setTimeout(done, 650));
    const leaseB = (await call('/lease', { ...b, action: 'acquire' })).result;
    assert.ok(leaseB.fence > leaseA.fence);
    const before = await snapshot();
    await assert.rejects(() => call('/import', { document: asDocument(maximum), lease: leaseA, forceStaleWrite: true }), /CHECK constraint failed/);
    assert.equal((await snapshot()).digest, before.digest);
    result.fencing = { staleBlocked: true, wholeBatchRollback: true, fenceIncreased: true };
    const renewal = await call('/lease', { ...leaseB, action: 'renew' }); assert.equal(renewal.result.fence, leaseB.fence);
    const saved = await call('/import', { document: asDocument(maximum), lease: leaseB });
    assert.equal(saved.metrics.document_batch_statements, 99);
    result.batch99 = saved;
    const prior = await snapshot();
    const failure = artifact.documents.find(row => row.id !== maximum.id && row.definitions.some(def => def.definition_version.includes('MERGER-TRANSACTION')));
    await assert.rejects(() => call('/import', { document: asDocument(failure), lease: leaseB, injectFailure: true }), /CHECK constraint failed/);
    assert.equal((await snapshot()).digest, prior.digest);
    result.rollback = { priorDocumentPreserved: true, failedDocumentChanges: 0 };
    const conflict = asDocument(maximum); conflict.records = structuredClone(conflict.records);
    conflict.records[0].raw_value += 1; conflict.records[0].canonical_value = conflict.records[0].raw_value * conflict.records[0].raw_unit_multiplier;
    await assert.rejects(() => call('/import', { document: conflict, lease: leaseB }), /값 충돌/);
    assert.equal((await snapshot()).digest, prior.digest);
    result.conflict = { rejected: true, writes: 0 };
    await call('/lease', { ...leaseB, action: 'release' }); clearSpecialized();
    const owner = (await call('/lease', { dataset, owner: 'P75_FULL', action: 'acquire' })).result;
    const run = async number => {
      const documents = [];
      for (const row of artifact.documents) {
        await call('/lease', { ...owner, action: 'renew' });
        const imported = await call('/import', { document: asDocument(row), lease: owner });
        // 즉시 remote에서 같은 입력을 다시 비교한다. 전체 rerun 이전부터 충돌 검증이 작동하는지 확인한다.
        const verified = await call('/verify', { document: asDocument(row) });
        assert.equal(verified.result.readVerified, true); assert.equal(verified.metrics.rows_written, 0);
        documents.push({ id: row.id, ...imported.result, importMetrics: imported.metrics, verificationMetrics: verified.metrics });
        console.log(`Run${number} ${row.id} PASS`);
      }
      const final = await snapshot(); delete final.arrays;
      assert.deepEqual(final.counts, artifact.expected.counts); assert.equal(final.digest, artifact.expected.digest);
      writeFileSync(`backups/p75/run-${number}.json`, JSON.stringify({ documents, final }, null, 2));
      return final;
    };
    result.run1 = await run(1); result.run2 = await run(2); assert.deepEqual(result.run1, result.run2);
    const complete = await snapshot();
    result.validation = Object.fromEntries(['validated', 'parsed'].map(status => [status, complete.arrays[1].filter(row => row.validation_status === status).length]));
    result.query = {};
    for (const scope of ['quarterly', 'annual', 'ytd']) {
      result.query[scope] = {};
      for (const metric of ['FFO', 'AFFO', 'NORMALIZED_FFO']) {
        const query = (await call('/query', { ticker: 'O', metricCode: metric, periodScope: scope, valueBasis: 'per_share', shareBasis: 'diluted' })).result;
        assert.ok(query.data.every(row => row.unit === 'USD/share' && row.provenance.length > 0));
        if (scope === 'annual') assert.ok(query.data.every(row => row.fiscalPeriod === 'FY'));
        if (scope === 'ytd') assert.ok(query.data.every(row => ['Q2', 'Q3'].includes(row.fiscalPeriod) && row.periodStart.endsWith('-01-01')));
        result.query[scope][metric] = { count: query.data.length, boundaries: query.definitionBoundaries.length, sourcePolicy: query.sourcePolicy };
      }
    }
    await call('/lease', { ...owner, action: 'release' });
    result.semanticEqualsSqlite = true;
  }
} finally {
  result.requests = requests.length;
  result.usage = requests.reduce((sum, request) => {
    for (const key of ['sql', 'rpc', 'rows_read', 'rows_written', 'd1_duration_ms', 'wall_ms']) sum[key] = (sum[key] || 0) + (request.metrics?.[key] || 0);
    return sum;
  }, {});
  writeFileSync(`backups/p75/${process.argv.includes('--original') ? 'original' : 'remote'}-results.json`, JSON.stringify(result, null, 2));
}
