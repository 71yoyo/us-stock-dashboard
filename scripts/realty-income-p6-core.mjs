import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHistoricalDatabase, specializedSnapshot, specializedStatistics, logicalDuplicates, hash } from './specialized-disposable-db.mjs';
import { backfillHistorical, assertParserDbAgreement } from './specialized-historical-backfill.mjs';
import { protectedDigest } from '../tests/helpers/specialized-metrics-db.js';
import { saveSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { querySpecializedMetrics } from '../worker/src/specialized-metric-query.js';
import { officialResults } from '../tests/helpers/realty-income-fixtures.js';
import { compareAnnualSources, reviewedAnnualProvenanceView } from './realty-income-p5cb2-cross-source.mjs';
import { summarize } from './realty-income-p5b-core.mjs';

const asResult = document => ({ status: 'parsed', definitions: document.definitions, records: document.records });
const verifyProtected = database => assert.equal(protectedDigest(database.sqlite), database.protectedBefore, '기존 재무/분류 데이터 변경');

// 고의 실패도 별도 메모리 DB에서만 실행한다. 실제 SQL trigger로 provenance 중간 insert를 실패시킨다.
export async function verifyStorageFailures(rows) {
  const database = await createHistoricalDatabase();
  const { sqlite, DB } = database;
  try {
    await backfillHistorical(database, [rows[0]]);
    const before = specializedSnapshot(sqlite);
    const existing = structuredClone(rows[0]);
    existing.records[0].raw_value += 1;
    existing.records[0].canonical_value = existing.records[0].raw_value * existing.records[0].raw_unit_multiplier;
    await assert.rejects(() => saveSpecializedMetrics(DB, asResult(existing)), /값 충돌/);
    assert.deepEqual(specializedSnapshot(sqlite), before);
    const definitionConflict = structuredClone(rows[0]);
    definitionConflict.definitions[0].definition_notes += ' SYNTHETIC CONFLICT';
    await assert.rejects(() => saveSpecializedMetrics(DB, asResult(definitionConflict)), /정의 변경 금지/);
    assert.deepEqual(specializedSnapshot(sqlite), before);

    const failure = rows.find(row => row.definitions.some(definition => definition.definition_version === 'NFFO-MERGER-TRANSACTION-OTHER-V1'));
    assert.ok(failure, 'rollback 검증용 신규 정의 문서가 없습니다.');
    sqlite.exec(`CREATE TEMP TRIGGER p6_provenance_failure BEFORE INSERT ON company_metric_sources
      WHEN NEW.section='Normalized FFO available to common stockholders'
      AND EXISTS (SELECT 1 FROM company_metric_sources prior WHERE prior.source_hash=NEW.source_hash
        AND prior.section='FFO available to common stockholders')
      BEGIN SELECT RAISE(ABORT,'P6_SYNTHETIC_PROVENANCE_FAILURE'); END;`);
    let attempted = 0;
    // 기존 transaction 실행을 관찰만 한다. 실패는 SQLite trigger가 발생시키며 사전 검증 실패로 대체하지 않는다.
    const originalBatch = DB.batch.bind(DB);
    DB.batch = async statements => { attempted = statements.length; return originalBatch(statements); };
    await assert.rejects(() => saveSpecializedMetrics(DB, asResult(failure)), /P6_SYNTHETIC_PROVENANCE_FAILURE/);
    assert.ok(attempted > failure.definitions.length + 2);
    assert.deepEqual(specializedSnapshot(sqlite), before, '문서 일부가 실패 후 남았습니다.');
    sqlite.exec('DROP TRIGGER p6_provenance_failure');
    await saveSpecializedMetrics(DB, asResult(failure));
    assert.ok(specializedSnapshot(sqlite).counts.values > before.counts.values, '실패 해제 후 정상 문서 저장 실패');
    verifyProtected(database);
    return { conflictRejected: true, existingValueUnchanged: true, definitionConflictRejected: true,
      rollback: { actualSqlTrigger: true, afterEarlierSourceInsert: true, batchStatements: attempted, documentAtomic: true,
        previousDocumentsPreserved: true, successfulRetryAfterRemovingTrigger: true } };
  } finally { sqlite.close(); }
}

// SEC/IR 정의가 다른 원본은 별도 identity로 남는다. B2에서 승인한 FY 동등성 view만 별도 DB에서 사용한다.
export async function verifyAdditionalProvenance(rows) {
  const database = await createHistoricalDatabase();
  try {
    const review = JSON.parse(readFileSync(new URL('../tests/fixtures/realty-income-p5cb2/cross-source-review.json', import.meta.url), 'utf8'));
    const pdfRow = rows.find(row => row.source_hash === review.pdf_source_hash);
    assert.ok(pdfRow, '동등성 검토와 동일한 PDF source가 없습니다.');
    const pdf = asResult(pdfRow), sec = (await officialResults())[0];
    const cross = compareAnnualSources(pdf, sec);
    assert.equal(cross.difference, 0);
    const view = reviewedAnnualProvenanceView(pdf, sec, review);
    const primary = { ...view, records: view.records.map(record => ({ ...record, sources: record.sources.slice(0, 1) })) };
    await saveSpecializedMetrics(database.DB, primary);
    const before = specializedSnapshot(database.sqlite);
    await saveSpecializedMetrics(database.DB, view);
    const after = specializedSnapshot(database.sqlite);
    assert.equal(after.counts.values, before.counts.values);
    assert.equal(after.counts.provenance, before.counts.provenance * 2);
    assert.equal(after.digests.values, before.digests.values);
    await saveSpecializedMetrics(database.DB, view);
    assert.deepEqual(specializedSnapshot(database.sqlite), after);
    assert.deepEqual(logicalDuplicates(database.sqlite), { value: 0, provenance: 0, definition: 0 });
    verifyProtected(database);
    return { compared: cross.compared, exact: cross.exact, difference: cross.difference, conflict: cross.conflict,
      before: before.counts, after: after.counts, repeatedSame: true, automaticDefinitionMerge: false,
      reviewedEquivalenceOnly: true, separateDisposableDatabase: true };
  } finally { database.sqlite.close(); }
}

export async function inspectHistoricalQueries(DB, rows) {
  const result = {};
  for (const scope of ['quarterly', 'annual', 'ytd']) {
    result[scope] = {};
    for (const metric of ['FFO', 'AFFO', 'NORMALIZED_FFO']) {
      const query = await querySpecializedMetrics(DB, { ticker: rows[0].records[0].ticker, metricCode: metric,
        periodScope: scope, valueBasis: 'per_share', shareBasis: 'diluted' });
      assert.ok(query.data.every((row, index) => index === 0 || query.data[index - 1].periodEnd <= row.periodEnd));
      assert.ok(query.data.every(row => row.unit === 'USD/share' && row.definitionVersion && row.provenance.length > 0));
      assert.equal(new Set(query.data.map(row => `${row.periodStart}|${row.periodEnd}`)).size, query.data.length);
      if (scope === 'quarterly') assert.ok(query.data.every(row => row.periodStart.slice(5, 7) === ({ Q1: '01', Q2: '04', Q3: '07', Q4: '10' })[row.fiscalPeriod]));
      if (scope === 'annual') assert.ok(query.data.every(row => row.fiscalPeriod === 'FY' && row.periodStart.endsWith('-01-01')));
      if (scope === 'ytd') assert.ok(query.data.every(row => ['Q2', 'Q3'].includes(row.fiscalPeriod) && row.periodStart.endsWith('-01-01')));
      result[scope][metric] = { rows: query.data.length, first: query.data[0]?.periodEnd ?? null,
        last: query.data.at(-1)?.periodEnd ?? null, boundaries: query.definitionBoundaries,
        periods: query.data.map(row => ({ year: row.fiscalYear, period: row.fiscalPeriod, start: row.periodStart, end: row.periodEnd,
          definition: row.definitionVersion, attribution: row.attributionBasis })) };
    }
  }
  return result;
}

export async function runHistoricalStorageAudit(rows) {
  const parserBefore = hash(rows);
  const databaseA = await createHistoricalDatabase();
  let databaseB;
  try {
    databaseB = await createHistoricalDatabase();
    const run1 = await backfillHistorical(databaseA, rows);
    const parserAgreement = assertParserDbAgreement(databaseA.sqlite, rows);
    const run2 = await backfillHistorical(databaseA, rows);
    assert.deepEqual(run2, run1, '동일 backfill 재실행으로 row/digest 변경');
    assertParserDbAgreement(databaseA.sqlite, rows);
    const rebuild = await backfillHistorical(databaseB, rows);
    assert.deepEqual(rebuild, run1, 'fresh DB A/B 재구축 결과 불일치');
    assertParserDbAgreement(databaseB.sqlite, rows);
    const duplicates = logicalDuplicates(databaseA.sqlite);
    assert.deepEqual(duplicates, { value: 0, provenance: 0, definition: 0 });
    const queries = await inspectHistoricalQueries(databaseA.DB, rows);
    const failures = await verifyStorageFailures(rows);
    const additionalProvenance = await verifyAdditionalProvenance(rows);
    verifyProtected(databaseA); verifyProtected(databaseB);
    assert.equal(hash(rows), parserBefore, 'P6가 parser 입력/결과를 변경했습니다.');
    return { scope: 'disposable local SQLite only; no production writes/routes',
      db: { mode: 'independent in-memory SQLite A/B plus isolated failure/provenance DBs', pathA: ':memory:', pathB: ':memory:',
        persistentFiles: 0, migrations: databaseA.migrationNames, migrationHash: databaseA.migrationHash,
        isolated: true, profile: databaseA.profile },
      input: { digest: parserBefore, summary: summarize(rows) }, run1, run2, parserAgreement,
      statistics: specializedStatistics(databaseA.sqlite), duplicates, queries, failures, additionalProvenance,
      rebuild: { ...rebuild, equal: true }, protectedDigestA: databaseA.protectedBefore,
      protectedDigestB: databaseB.protectedBefore, protectedUnchanged: true, parserUnchanged: true,
      production: { migration: false, write: false, workerDeploy: false, pagesDeploy: false, ui: false,
        backfill: false, commit: false, push: false }, databaseClosedAfterAudit: true };
  } finally { databaseA.sqlite.close(); databaseB?.sqlite.close(); }
}
