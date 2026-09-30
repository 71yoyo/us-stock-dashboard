import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { classificationStatement } from '../worker/src/company-classification.js';
import { syncProfile } from '../worker/src/fmp-sync.js';
import { ensureFundamentalStore } from '../worker/src/fundamental-store.js';
import worker from '../worker/src/index.js';

// 수동 로컬 검증 전용: 운영 공개 회사 GET만 각 1회 읽고 모든 저장·migration은 메모리에서 수행한다.
// 실제 FMP/SEC 호출·운영 D1 접근·파일 캐시·재시도는 없다. npm test에서는 실행하지 않는다.
const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/company-classification-metadata.json', import.meta.url), 'utf8'));
const companies = [];
for (const expected of fixture.companies) {
  const response = await fetch(`https://us-stock-dashboard-api.771yoyo.workers.dev/api/companies/${expected.ticker}`,
    { signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, `${expected.ticker} 저장 응답 조회 실패`);
  const { company } = await response.json();
  assert.equal(company.ticker, expected.ticker);
  assert.equal(company.sector, expected.sector, '저장 metadata가 바뀌었습니다. fixture를 검토해 주세요.');
  assert.equal(company.industry, expected.industry, '저장 metadata가 바뀌었습니다. fixture를 검토해 주세요.');
  assert.ok(Array.isArray(company.financials));
  companies.push(company);
}

const sqlite = new DatabaseSync(':memory:');
const prepare = sql => ({ sql, values: [], bind(...values) { this.values = values; return this; },
  async first() { return sqlite.prepare(sql).get(...this.values) || null; },
  async all() { return { results: sqlite.prepare(sql).all(...this.values) }; },
  async run() { return sqlite.prepare(sql).run(...this.values); }
});
const DB = { prepare, async batch(statements) {
  sqlite.exec('BEGIN');
  try {
    const results = statements.map(item => ({ results: sqlite.prepare(item.sql).all(...item.values) }));
    sqlite.exec('COMMIT'); return results;
  } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
} };
const environment = { DB };
const metrics = {
  revenue: 'revenue', operatingIncome: 'operating_income', netIncome: 'net_income', eps: 'eps',
  pegRatio: 'peg_ratio', peRatio: 'pe_ratio', psRatio: 'ps_ratio', freeCashFlow: 'free_cash_flow',
  roe: 'roe', roic: 'roic', grossMargin: 'gross_margin', operatingMargin: 'operating_margin'
};
const metadata = { periodType: 'period_type', fiscalPeriodEnd: 'fiscal_period_end', reportedDate: 'reported_date',
  fiscalYear: 'fiscal_year', fiscalPeriod: 'fiscal_period', periodStart: 'period_start', source: 'source', cachedAt: 'cached_at' };
const fields = { ...metadata, ...metrics };
const snapshot = () => sqlite.prepare('SELECT * FROM financial_metrics ORDER BY ticker,period_type,fiscal_period_end').all();
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const originalFetch = globalThis.fetch;

try {
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../worker/migrations/', import.meta.url)).sort()) {
    if (name === '0017_company_classification.sql') break;
    sqlite.exec(readFileSync(new URL(`../worker/migrations/${name}`, import.meta.url), 'utf8'));
  }
  const insert = sqlite.prepare(`INSERT INTO financial_metrics(ticker,${Object.values(fields).join(',')})
    VALUES (${Array(Object.keys(fields).length + 1).fill('?').join(',')})`);
  for (const company of companies) {
    sqlite.prepare('INSERT INTO companies(ticker,name,sector,industry,exchange,currency) VALUES (?,?,?,?,?,?)')
      .run(company.ticker, company.name, company.sector, company.industry, company.exchange, company.currency);
    for (const row of company.financials) insert.run(company.ticker, ...Object.keys(fields).map(key => row[key] ?? null));
  }
  await ensureFundamentalStore(environment);
  // 자료를 읽은 뒤 네트워크를 차단한다. syncProfile에는 실제로 읽은 metadata만 재생한다.
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'financialmodelingprep.com');
    assert.equal(parsed.pathname, '/stable/profile');
    const company = companies.find(item => item.ticker === parsed.searchParams.get('symbol'));
    assert.ok(company, '검증 대상 밖의 외부 요청');
    return Response.json([{ companyName: company.name, sector: company.sector, industry: company.industry,
      exchange: company.exchange, currency: company.currency }]);
  };
  const api = async ticker => {
    const response = await worker.fetch(new Request(`https://example.test/api/companies/${ticker}`), environment);
    assert.equal(response.status, 200);
    return (await response.json()).company;
  };
  const before = snapshot();
  const apiBefore = new Map();
  for (const company of companies) apiBefore.set(company.ticker, await api(company.ticker));
  sqlite.exec(readFileSync(new URL('../worker/migrations/0017_company_classification.sql', import.meta.url), 'utf8'));
  for (const company of companies) await classificationStatement(DB, company).run();
  const results = [];
  for (const company of companies) {
    const after = await api(company.ticker);
    const { analysisProfile: oldProfile, ...oldFields } = apiBefore.get(company.ticker);
    const { analysisProfile, ...newFields } = after;
    assert.deepEqual(newFields, oldFields, `${company.ticker} 기존 API 필드 회귀`);
    results.push({ ticker: company.ticker, sector: company.sector, industry: company.industry,
      autoProfile: analysisProfile.autoType, effectiveProfile: analysisProfile.type });
    await syncProfile({ ...environment, MARKET_DATA_API_KEY: 'local-test-placeholder' }, company.ticker);
  }
  const after = snapshot();
  assert.deepEqual(after, before, '분류 작업이 재무 저장값을 변경했습니다.');
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  const availableNumericValues = before.reduce((sum, row) => sum
    + Object.values(metrics).filter(field => typeof row[field] === 'number').length, 0);
  console.log(JSON.stringify({ companies: results, financialRows: before.length,
    comparedFieldsIncludingNull: before.length * Object.keys(metrics).length, availableNumericValues,
    changedFinancialRows: 0, beforeDigest: digest(before), afterDigest: digest(after),
    apiCompatibility: 'PASS', productionReadRequests: companies.length, productionWrite: false,
    migrationTarget: 'memory SQLite only', profileSync: '실제 저장 metadata를 mock 응답으로 재생' }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  sqlite.close();
}
