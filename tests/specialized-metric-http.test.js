import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/src/index.js';
import { p5cb2Results } from './helpers/realty-income-p5cb2-fixtures.js';
import { createHistoricalDatabase, specializedSnapshot } from '../scripts/specialized-disposable-db.mjs';
import { backfillHistorical } from '../scripts/specialized-historical-backfill.mjs';
import { classificationStatement } from '../worker/src/company-classification.js';
import { querySpecializedMetrics } from '../worker/src/specialized-metric-query.js';
import { parseSpecializedHttpQuery, serializeSpecializedSeries } from '../worker/src/specialized-metric-http.js';
import { SERIES } from '../scripts/p77-gate-core.mjs';

// 공식 최소 fixture를 별도 메모리 DB에만 적재한다. HTTP 요청은 SELECT 외 실행을 거부한다.
const database = p5cb2Results().then(async documents => {
  const db = await createHistoricalDatabase();
  await backfillHistorical(db, documents);
  for (const [ticker, sector, industry] of [['JPM', 'Financial Services', 'Banks - Diversified'],
    ['GENERAL', 'Technology', 'Semiconductors'], ['EXCHANGE', 'Financial Services', 'Financial Data & Stock Exchanges'],
    ['UNKNOWN', null, null], ['REIT', 'Real Estate', 'REIT - Retail']]) {
    db.sqlite.prepare('INSERT INTO companies(ticker,name,sector,industry) VALUES (?,?,?,?)').run(ticker, ticker, sector, industry);
    await classificationStatement(db.DB, { ticker, sector, industry }).run();
  }
  return db;
});
after(async () => (await database).sqlite.close());
const params = overrides => new URLSearchParams({ metric: 'AFFO', scope: 'quarterly', basis: 'per_share', shareBasis: 'diluted', ...overrides });
const request = (ticker = 'O', query = params(), method = 'GET') =>
  new Request(`https://worker.test/api/companies/${ticker}/specialized-metrics?${query}`, { method });
async function call(req, t) {
  const { DB, sqlite } = await database;
  const statements = [];
  const before = sqlite.prepare('SELECT total_changes() AS count').get().count;
  const protectedBefore = specializedSnapshot(sqlite);
  const readOnly = { prepare(sql) {
    assert.match(sql.trim(), /^SELECT\b/i); statements.push(sql);
    return DB.prepare(sql);
  } };
  if (t) t.mock.method(globalThis, 'fetch', () => { throw new Error('조회 중 외부 API 호출 금지'); });
  const response = await worker.fetch(req, { DB: readOnly });
  assert.deepEqual(specializedSnapshot(sqlite), protectedBefore);
  assert.equal(sqlite.prepare('SELECT total_changes() AS count').get().count, before);
  return { response, body: await response.json(), statements };
}

for (const series of SERIES) test(`P9A 실제 router ${series.id} = ${series.expected}, query 의미 보존`, async t => {
  const { response, body, statements } = await call(request('o', params({ metric: series.query.metricCode, scope: series.query.periodScope })), t);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(body.ticker, 'O'); assert.equal(body.analysisProfile.type, 'REIT');
  assert.equal(body.data.length, series.expected); assert.equal(body.unit, 'USD/share');
  assert.equal(body.economicContinuityAssumed, false); assert.equal(body.available, true);
  assert.equal(statements.length, 3);
  const service = await querySpecializedMetrics((await database).DB, series.query);
  assert.deepEqual(body, serializeSpecializedSeries(service, body.analysisProfile));
  assert.deepEqual(body.definitionBoundaries, service.definitionBoundaries);
  for (const [i, row] of body.data.entries()) {
    for (const key of ['value', 'fiscalYear', 'fiscalPeriod', 'periodStart', 'periodEnd', 'unit',
      'definitionOwner', 'definitionVersion', 'validationStatus', 'attributionBasis']) assert.deepEqual(row[key], service.data[i][key]);
    assert.ok(row.sourceSummary.count > 0);
    for (const key of ['provenance', 'rawValue', 'rawUnit', 'growth', 'yoy', 'cagr']) assert.equal(Object.hasOwn(row, key), false);
  }
});

for (const [ticker, profile] of [['JPM', 'BANK'], ['GENERAL', 'GENERAL'], ['EXCHANGE', 'EXCHANGE'], ['UNKNOWN', 'UNKNOWN'], ['REIT', 'REIT']]) {
  test(`P9A ${profile} 미보유 series는 가짜 값 없이 empty`, async () => {
    const { response, body } = await call(request(ticker));
    assert.equal(response.status, 200); assert.equal(body.analysisProfile.type, profile);
    assert.deepEqual(body.data, []); assert.deepEqual(body.definitionBoundaries, []);
    assert.equal(body.unit, null); assert.equal(body.available, false); assert.equal(body.availability, 'no_stored_data');
    assert.equal(body.economicContinuityAssumed, false);
  });
}
test('P9A periodEnd 날짜 양끝 inclusive, actual total 저장값만 반환', async () => {
  const { body } = await call(request('O', params({ start: '2025-03-31', end: '2025-09-30' })));
  assert.deepEqual(body.data.map(row => row.periodEnd), ['2025-03-31', '2025-06-30', '2025-09-30']);
  const { body: common } = await call(request('O', params({ metric: 'FFO', basis: 'total', shareBasis: 'not_applicable' })));
  assert.equal(common.unit, 'USD'); assert.equal(common.data.length, 40);
  const { body: diluted } = await call(request('O', params({ metric: 'FFO', scope: 'annual', basis: 'total' })));
  assert.equal(diluted.data.length, 9); // 미공시 2016 diluted total을 common total로 채우지 않는다.
});

for (const [label, query] of [['기본 전체 조회', new URLSearchParams()],
  ['metric 누락', new URLSearchParams('scope=quarterly&basis=per_share&shareBasis=diluted')],
  ['unknown metric', params({ metric: 'EBITDA' })], ['SQL metric', params({ metric: "AFFO' OR 1=1--" })],
  ['scope', params({ scope: 'ttm' })], ['basis', params({ basis: 'common_total' })],
  ['shareBasis', params({ shareBasis: 'unknown' })], ['per share 기준 없음', params({ shareBasis: 'not_applicable' })],
  ['합성 basic total', params({ basis: 'total', shareBasis: 'basic' })],
  ['날짜 형식', params({ start: '2025-2-1' })], ['존재하지 않는 날짜', params({ end: '2025-02-29' })],
  ['날짜 역전', params({ start: '2025-12-31', end: '2025-01-01' })],
  ['빈 날짜', params({ start: '' })], ['비교 열 우회', params({ includeComparisons: 'true' })],
  ['미등록 parameter', params({ table: 'companies' })], ['중복 parameter', new URLSearchParams(`${params()}&metric=FFO`)]]) {
  test(`P9A ${label}은 DB 접근 전 400`, async () => {
    const { response, body, statements } = await call(request('O', query));
    assert.equal(response.status, 400); assert.equal(typeof body.error, 'string'); assert.equal(statements.length, 0);
  });
}
for (const ticker of ['123', '%FF', 'O%2FJPM', "O%27%20OR%201%3D1"]) test(`P9A 잘못된 ticker ${ticker}`, async () => {
  const { response, statements } = await call(request(ticker)); assert.equal(response.status, 400); assert.equal(statements.length, 0);
});
test('P9A 미등록 회사 404, POST 405, OPTIONS 기존 CORS 유지', async () => {
  assert.equal((await call(request('ABSENT'))).response.status, 404);
  const post = await call(request('O', params(), 'POST')); assert.equal(post.response.status, 405); assert.equal(post.statements.length, 0);
  const options = await worker.fetch(request('O', params(), 'OPTIONS'), {}); assert.equal(options.status, 204);
});
test('P9A DB failure 502는 내부 오류/credential을 출력하지 않음', async () => {
  const response = await worker.fetch(request(), { DB: { prepare() { throw new Error('PRIVATE_INTERNAL_ERROR'); } } });
  assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /PRIVATE_INTERNAL_ERROR/);
});
test('P9A 조회 이후 health 및 기존 회사/list API 응답 불변', async () => {
  const { DB } = await database;
  const existingApiDB = { ...DB, batch: statements => Promise.all(statements.map(statement => statement.all())) };
  // 기존 company GET의 legacy store 준비 경로는 그대로 유지하며 메모리 DB에서만 실행한다.
  const paths = ['/api/health', '/api/companies', '/api/companies/O', '/api/companies/JPM'];
  const read = async path => {
    const response = await worker.fetch(new Request(`https://worker.test${path}`), { DB: existingApiDB });
    assert.equal(response.status, 200); return response.json();
  };
  const before = await Promise.all(paths.map(read)); await call(request());
  const after = await Promise.all(paths.map(read)); assert.deepEqual(after, before);
});
test('P9A router 수정은 기존 route/scheduler 코드를 재작성하지 않음', () => {
  const source = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');
  assert.match(source, /parseSpecializedHttpQuery\(ticker, url.searchParams\)/);
  assert.deepEqual(parseSpecializedHttpQuery('O', params()).includeComparisons, false);
});
test('P9A 내부 compact 옵션은 기본 서비스의 출처 건수/종류와 동일하고 상세 기본 계약 유지', async () => {
  const { DB } = await database;
  for (const series of SERIES) {
    const detailed = await querySpecializedMetrics(DB, series.query);
    const compact = await querySpecializedMetrics(DB, series.query, { sourceSummaryOnly: true });
    assert.deepEqual(serializeSpecializedSeries(compact, { type: 'REIT' }), serializeSpecializedSeries(detailed, { type: 'REIT' }));
    assert.ok(detailed.data.every(row => row.provenance?.length > 0 && !Object.hasOwn(row, 'sourceSummary')));
  }
  await assert.rejects(querySpecializedMetrics(DB, SERIES[0].query, { sourceSummaryOnly: 'true' }), /출처 조회 옵션/);
  await assert.rejects(querySpecializedMetrics(DB, SERIES[0].query, { unknown: true }), /출처 조회 옵션/);
});
test('P9A compact 출처 경로도 손상 metadata를 숨기지 않는다', async () => {
  const { DB, sqlite } = await database;
  const source = sqlite.prepare(`SELECT * FROM company_metric_sources WHERE record_key IN
    (SELECT record_key FROM company_metric_values WHERE metric_code='AFFO' AND period_scope='quarterly'
      AND value_basis='per_share' AND share_basis='diluted') LIMIT 1`).get();
  const update = sqlite.prepare('UPDATE company_metric_sources SET source_metadata_json=? WHERE record_key=? AND source_url=? AND source_hash=?');
  // 손상 상황은 독립 메모리 fixture에서만 만들고 finally로 원문을 복원한다.
  try {
    update.run('[]', source.record_key, source.source_url, source.source_hash);
    await assert.rejects(querySpecializedMetrics(DB, { ...SERIES[1].query, includeComparisons: true }), /metadata가 객체가 아닙니다/);
    await assert.rejects(querySpecializedMetrics(DB, { ...SERIES[1].query, includeComparisons: true }, { sourceSummaryOnly: true }), /metadata가 손상/);
  } finally { update.run(source.source_metadata_json, source.record_key, source.source_url, source.source_hash); }
});
test('P9A JOIN profile도 수동 Override/stale 의미를 기존 API와 동일하게 보존', async () => {
  const { sqlite, DB } = await database;
  const stored = sqlite.prepare('SELECT * FROM company_classification WHERE ticker=?').get('JPM');
  try {
    sqlite.prepare(`UPDATE company_classification SET manual_override='UNKNOWN',manual_override_reason='로컬 재검토',
      effective_profile='UNKNOWN',review_status='overridden',rule_version=2 WHERE ticker='JPM'`).run();
    const { body } = await call(request('JPM'));
    const company = sqlite.prepare('SELECT * FROM companies WHERE ticker=?').get('JPM');
    const { readAnalysisProfile } = await import('../worker/src/company-classification.js');
    assert.deepEqual(body.analysisProfile, await readAnalysisProfile({ DB }, company));
    assert.equal(body.analysisProfile.type, 'UNKNOWN'); assert.equal(body.analysisProfile.storageStatus, 'stale');
  } finally {
    sqlite.prepare('UPDATE company_classification SET manual_override=?,manual_override_reason=?,effective_profile=?,review_status=?,rule_version=? WHERE ticker=?')
      .run(stored.manual_override, stored.manual_override_reason, stored.effective_profile, stored.review_status, stored.rule_version, 'JPM');
  }
});
