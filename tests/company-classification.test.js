import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ANALYSIS_PROFILES, CLASSIFICATION_RULE_VERSION, isAnalysisProfile, classifyCompany,
  analysisProfileFor, classificationStatement, readAnalysisProfile, setManualClassification
} from '../worker/src/company-classification.js';
import { syncProfile } from '../worker/src/fmp-sync.js';
import { ensureFundamentalStore } from '../worker/src/fundamental-store.js';
import worker from '../worker/src/index.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/company-classification-metadata.json', import.meta.url), 'utf8'));
const migrationName = '0017_company_classification.sql';
const migrations = readdirSync(new URL('../worker/migrations/', import.meta.url)).sort();
const migrationSql = name => readFileSync(new URL(`../worker/migrations/${name}`, import.meta.url), 'utf8');

// 실 SQLite의 SQL·제약·트랜잭션을 메모리에서 검증하며 운영 DB와 실제 API를 사용하지 않는다.
function database(includeClassification = true) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of migrations) {
    if (!includeClassification && name === migrationName) break;
    sqlite.exec(migrationSql(name));
  }
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
  return { sqlite, DB };
}
function insertCompany(sqlite, company) {
  sqlite.prepare('INSERT INTO companies(ticker,name,sector,industry,cik) VALUES (?,?,?,?,?)')
    .run(company.ticker, company.ticker, company.sector || null, company.industry || null, company.cik || null);
}
const storedRow = (sqlite, ticker = 'TEST') => sqlite.prepare('SELECT * FROM company_classification WHERE ticker=?').get(ticker);
const bank = { ticker: 'TEST', sector: 'Financial Services', industry: 'Banks - Diversified', cik: '1' };

test('Profile Enum은 다섯 유형만 허용하고 rule version은 양의 정수다', () => {
  assert.deepEqual(Object.values(ANALYSIS_PROFILES), ['GENERAL', 'REIT', 'BANK', 'EXCHANGE', 'UNKNOWN']);
  assert.ok(Number.isInteger(CLASSIFICATION_RULE_VERSION) && CLASSIFICATION_RULE_VERSION > 0);
  for (const value of Object.values(ANALYSIS_PROFILES)) assert.equal(isAnalysisProfile(value), true);
  for (const value of [null, 'bank', 'INSURANCE', {}, '']) assert.equal(isAnalysisProfile(value), false);
});

for (const [industry, sector, expected] of [
  ['Semiconductors', 'Technology', 'GENERAL'], ['REIT - Retail', 'Real Estate', 'REIT'],
  ['Banks - Diversified', 'Financial Services', 'BANK'],
  ['Financial Data & Stock Exchanges', 'Financial Services', 'EXCHANGE']
]) {
  test(`${industry}는 정확한 Industry 규칙으로 ${expected}가 된다`, () => {
    const result = classifyCompany({ industry, sector });
    assert.equal(result.autoType, expected);
    assert.equal(result.confidence, 'high');
    assert.equal(result.ruleVersion, CLASSIFICATION_RULE_VERSION);
  });
}

test('현재 10종목의 실제 metadata는 ticker별 기대값이 아니라 산업별 규칙을 통과한다', () => {
  assert.equal(fixture.companies.length, 10);
  const expectedByIndustry = {
    'Semiconductors': 'GENERAL', 'Consumer Electronics': 'GENERAL', 'Software - Infrastructure': 'GENERAL',
    'Banks - Diversified': 'BANK', 'REIT - Retail': 'REIT', 'Drug Manufacturers - General': 'GENERAL',
    'Medical - Devices': 'GENERAL', 'Specialty Retail': 'GENERAL',
    'Internet Content & Information': 'GENERAL', 'Auto - Manufacturers': 'GENERAL'
  };
  for (const company of fixture.companies) {
    assert.equal(classifyCompany(company).autoType, expectedByIndustry[company.industry]);
    assert.deepEqual(classifyCompany(company), classifyCompany({ ...company, ticker: 'UNRELATED' }));
  }
});

test('ticker·상장 거래소·재무 NULL·가짜 security/SIC 필드는 판정에 영향을 주지 않는다', () => {
  for (const ticker of ['O', 'JPM', 'CME', 'ANY']) {
    const extra = { ticker, exchange: 'NASDAQ', operatingIncome: null, grossMargin: null, ffo: null,
      sic: '6798', securityType: 'REIT' };
    assert.equal(classifyCompany(extra).autoType, 'UNKNOWN');
    assert.equal(classifyCompany({ ...bank, ...extra }).autoType, 'BANK');
  }
});

test('Financial Services 및 Real Estate Sector만으로 전문 Profile을 만들지 않는다', () => {
  for (const sector of ['Financial Services', 'Real Estate', 'Technology']) {
    assert.equal(classifyCompany({ sector, industry: null }).autoType, 'UNKNOWN');
  }
});

test('미등록·모호·잘못된 Industry 입력은 GENERAL 대신 UNKNOWN과 검토 상태가 된다', () => {
  for (const industry of ['Unknown Industry', 'Financial Services', 'Banks', 'REIT', 'REIT - Mortgage', {}, 0, '']) {
    const result = classifyCompany({ industry });
    assert.equal(result.autoType, 'UNKNOWN');
    assert.equal(result.reviewStatus, 'needs_review');
    assert.equal(result.confidence, 'low');
  }
  assert.equal(classifyCompany(null).autoType, 'UNKNOWN');
});

test('Sector와 정확한 Industry가 충돌하면 UNKNOWN이며 공백·대소문자는 안전하게 정규화한다', () => {
  assert.equal(classifyCompany({ sector: 'Technology', industry: 'Banks - Diversified' }).autoType, 'UNKNOWN');
  assert.equal(classifyCompany({ sector: ' financial  services ', industry: ' BANKS - DIVERSIFIED ' }).autoType, 'BANK');
  assert.equal(classifyCompany({ industry: 'REIT - Retail' }).autoType, 'REIT');
});

test('Fresh DB에 0001부터 0017까지 적용하면 분류 schema·index·FK만 추가된다', () => {
  const { sqlite } = database();
  try {
    const columns = sqlite.prepare('PRAGMA table_info(company_classification)').all().map(row => row.name);
    for (const field of ['ticker', 'company_cik', 'auto_profile', 'effective_profile', 'source_sector', 'source_industry',
      'classification_reason', 'confidence', 'rule_version', 'manual_override', 'manual_override_reason',
      'review_status', 'classified_at', 'updated_at']) assert.ok(columns.includes(field));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM company_classification').get().n, 0);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='idx_company_classification_cik'").get());
  } finally { sqlite.close(); }
});

test('Existing DB에 0017만 적용하고 10종목을 분류해도 모든 재무값 digest는 동일하다', async () => {
  const { sqlite, DB } = database(false);
  try {
    // metadata만 실제 저장 입력이다. 아래 재무값은 NULL·음수·0 보존을 검증하는 인공 표본이다.
    for (const company of fixture.companies) {
      insertCompany(sqlite, company);
      for (const period of ['annual', 'quarterly']) sqlite.prepare(`INSERT INTO financial_metrics
        (ticker,period_type,fiscal_period_end,revenue,operating_income,net_income,eps,free_cash_flow,
         roe,roic,gross_margin,operating_margin,source)
        VALUES (?,?, '2025-12-31',100,NULL,-20,0,30,12,NULL,NULL,NULL,'SEC EDGAR')`).run(company.ticker, period);
    }
    const snapshot = () => JSON.stringify(sqlite.prepare('SELECT * FROM financial_metrics ORDER BY ticker,period_type').all());
    const before = snapshot();
    const companiesBefore = sqlite.prepare('SELECT * FROM companies ORDER BY ticker').all();
    sqlite.exec(migrationSql(migrationName));
    for (const company of fixture.companies) await classificationStatement(DB, company).run();
    assert.deepEqual(sqlite.prepare('SELECT * FROM companies ORDER BY ticker').all(), companiesBefore);
    assert.equal(snapshot(), before);
    assert.equal(createHash('sha256').update(snapshot()).digest('hex'), createHash('sha256').update(before).digest('hex'));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM company_classification').get().n, 10);
  } finally { sqlite.close(); }
});

test('자동 분류를 저장하면 rule version·원본 sector/industry·회사 CIK를 보존한다', async () => {
  const { sqlite, DB } = database();
  try {
    insertCompany(sqlite, bank);
    await classificationStatement(DB, bank).run();
    const row = storedRow(sqlite);
    assert.equal(row.auto_profile, 'BANK');
    assert.equal(row.effective_profile, 'BANK');
    assert.equal(row.rule_version, CLASSIFICATION_RULE_VERSION);
    assert.equal(row.company_cik, '1');
    assert.equal(row.source_sector, bank.sector);
    assert.equal(row.source_industry, bank.industry);
    assert.ok(row.classified_at && row.updated_at);
  } finally { sqlite.close(); }
});

test('Manual Override가 우선하며 해제 시 자동 Profile로 복귀한다', async () => {
  const { sqlite, DB } = database();
  try {
    insertCompany(sqlite, bank);
    await classificationStatement(DB, bank).run();
    await setManualClassification({ DB }, 'TEST', 'EXCHANGE', '공식 사업 설명 검토');
    const overridden = await readAnalysisProfile({ DB }, bank);
    assert.equal(overridden.type, 'EXCHANGE');
    assert.equal(overridden.autoType, 'BANK');
    assert.equal(overridden.overridden, true);
    assert.equal(overridden.reviewStatus, 'overridden');
    await setManualClassification({ DB }, 'TEST', null);
    assert.equal((await readAnalysisProfile({ DB }, bank)).type, 'BANK');
    assert.equal(storedRow(sqlite).manual_override_reason, null);
  } finally { sqlite.close(); }
});

test('잘못된 Override·빈 이유·미등록 회사는 거부하고 기존 분류를 변경하지 않는다', async () => {
  const { sqlite, DB } = database();
  try {
    insertCompany(sqlite, bank);
    await classificationStatement(DB, bank).run();
    const before = storedRow(sqlite);
    await assert.rejects(setManualClassification({ DB }, 'TEST', 'INVALID', '검토'), /지원하지/);
    await assert.rejects(setManualClassification({ DB }, 'TEST', 'EXCHANGE', ' '), /이유/);
    await assert.rejects(setManualClassification({ DB }, 'MISSING', 'BANK', '검토'), /먼저/);
    await assert.rejects(setManualClassification({ DB }, 'bad ticker', 'BANK', '검토'), /ticker/);
    assert.deepEqual(storedRow(sqlite), before);
    assert.equal(analysisProfileFor(bank, { manual_override: 'INVALID', manual_override_reason: '오류' }).type, 'BANK');
  } finally { sqlite.close(); }
});

test('실제 syncProfile 경로 재실행은 Override와 이유를 보존하고 자동 근거만 갱신한다', async t => {
  const { sqlite, DB } = database();
  try {
    insertCompany(sqlite, bank);
    await classificationStatement(DB, bank).run();
    await setManualClassification({ DB }, 'TEST', 'EXCHANGE', '관리자 검증');
    t.mock.method(globalThis, 'fetch', async url => {
      assert.equal(new URL(url).pathname, '/stable/profile');
      return Response.json([{ companyName: '회사정보 갱신', sector: 'Technology', industry: 'Semiconductors' }]);
    });
    await syncProfile({ DB, MARKET_DATA_API_KEY: 'local-test-placeholder' }, 'TEST');
    const row = storedRow(sqlite);
    assert.equal(row.auto_profile, 'GENERAL');
    assert.equal(row.effective_profile, 'EXCHANGE');
    assert.equal(row.manual_override, 'EXCHANGE');
    assert.equal(row.manual_override_reason, '관리자 검증');
    assert.equal(row.company_cik, '1');
    assert.equal((await readAnalysisProfile({ DB }, { sector: 'Technology', industry: 'Semiconductors', ticker: 'TEST' })).type, 'EXCHANGE');
  } finally { sqlite.close(); }
});

test('분류 저장 실패 시 syncProfile의 회사정보 변경도 같은 batch에서 롤백된다', async t => {
  const { sqlite, DB } = database();
  try {
    insertCompany(sqlite, bank);
    sqlite.exec(`CREATE TRIGGER fail_classification BEFORE INSERT ON company_classification
      BEGIN SELECT RAISE(ABORT,'분류 쓰기 차단'); END;`);
    const before = sqlite.prepare('SELECT * FROM companies').all();
    t.mock.method(globalThis, 'fetch', async () => Response.json([{ companyName: '변경 금지', sector: 'Technology', industry: 'Semiconductors' }]));
    await assert.rejects(syncProfile({ DB, MARKET_DATA_API_KEY: 'local-test-placeholder' }, 'TEST'), /분류 쓰기 차단/);
    assert.deepEqual(sqlite.prepare('SELECT * FROM companies').all(), before);
  } finally { sqlite.close(); }
});

test('DB 제약은 Enum·Override 이유·effective 일관성·FK 위반을 차단한다', async () => {
  const { sqlite, DB } = database();
  try {
    insertCompany(sqlite, bank);
    await classificationStatement(DB, bank).run();
    for (const sql of ["UPDATE company_classification SET auto_profile='BAD'",
      "UPDATE company_classification SET effective_profile='GENERAL'",
      "UPDATE company_classification SET manual_override='EXCHANGE'",
      "UPDATE company_classification SET rule_version=0"]) assert.throws(() => sqlite.exec(sql), /CHECK/);
    await assert.rejects(classificationStatement(DB, { ...bank, ticker: 'MISSING' }).run(), /FOREIGN KEY/);
    sqlite.exec("DELETE FROM companies WHERE ticker='TEST'");
    assert.equal(storedRow(sqlite), undefined);
  } finally { sqlite.close(); }
});

test('미적용 migration·미저장·오래된 metadata는 읽기 전용 runtime fallback을 사용한다', async () => {
  const { sqlite, DB } = database(false);
  try {
    insertCompany(sqlite, bank);
    assert.equal((await readAnalysisProfile({ DB }, bank)).storageStatus, 'not_stored');
    sqlite.exec(migrationSql(migrationName));
    await classificationStatement(DB, bank).run();
    const changed = { ...bank, sector: 'Real Estate', industry: 'REIT - Retail' };
    const fallback = analysisProfileFor(changed, storedRow(sqlite));
    assert.equal(fallback.type, 'REIT');
    assert.equal(fallback.storageStatus, 'stale');
    assert.equal(storedRow(sqlite).auto_profile, 'BANK');
  } finally { sqlite.close(); }
});

test('분류 읽기의 일반 DB 오류는 migration 미적용으로 숨기지 않는다', async () => {
  const DB = { prepare() { throw new Error('DB 연결 실패'); } };
  await assert.rejects(readAnalysisProfile({ DB }, bank), /DB 연결 실패/);
});

test('회사정보의 sector/industry가 누락돼도 NULL로 저장하고 UNKNOWN으로 분류한다', async t => {
  const { sqlite, DB } = database();
  try {
    t.mock.method(globalThis, 'fetch', async () => Response.json([{ companyName: '분류 정보 미확보' }]));
    await syncProfile({ DB, MARKET_DATA_API_KEY: 'local-test-placeholder' }, 'NEW');
    const row = storedRow(sqlite, 'NEW');
    assert.equal(row.auto_profile, 'UNKNOWN');
    assert.equal(row.effective_profile, 'UNKNOWN');
    assert.equal(row.source_sector, null);
    assert.equal(row.source_industry, null);
    assert.equal(row.review_status, 'needs_review');
  } finally { sqlite.close(); }
});

test('과거 rule version은 runtime에서 재판정하며 저장된 Override는 유지한다', async () => {
  const { sqlite, DB } = database();
  try {
    insertCompany(sqlite, bank);
    await classificationStatement(DB, bank).run();
    await setManualClassification({ DB }, 'TEST', 'UNKNOWN', '사업유형 재검토');
    sqlite.exec('UPDATE company_classification SET rule_version=2');
    const result = await readAnalysisProfile({ DB }, bank);
    assert.equal(result.storageStatus, 'stale');
    assert.equal(result.ruleVersion, CLASSIFICATION_RULE_VERSION);
    assert.equal(result.autoType, 'BANK');
    assert.equal(result.type, 'UNKNOWN');
    assert.equal(storedRow(sqlite).rule_version, 2);
  } finally { sqlite.close(); }
});

test('회사 API는 analysisProfile만 additive로 제공하고 기존 필드·재무·배당·일봉을 유지한다', async t => {
  const { sqlite, DB } = database(false);
  try {
    insertCompany(sqlite, bank);
    const environment = { DB };
    await ensureFundamentalStore(environment);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('조회 중 외부 호출 금지'); });
    const request = () => worker.fetch(new Request('https://example.test/api/companies/TEST'), environment);
    const beforeResponse = await request();
    assert.equal(beforeResponse.status, 200);
    const before = (await beforeResponse.json()).company;
    assert.equal(before.analysisProfile.type, 'BANK');
    assert.equal(before.analysisProfile.storageStatus, 'not_stored');
    sqlite.exec(migrationSql(migrationName));
    await classificationStatement(DB, bank).run();
    const afterResponse = await request();
    assert.equal(afterResponse.status, 200);
    const after = (await afterResponse.json()).company;
    assert.equal(after.analysisProfile.storageStatus, 'current');
    const { analysisProfile: beforeProfile, ...oldFields } = before;
    const { analysisProfile: afterProfile, ...newFields } = after;
    assert.deepEqual(newFields, oldFields);
    for (const field of ['ticker', 'sector', 'industry', 'financials', 'candles', 'dividendMetrics', 'technicalSignal']) assert.ok(field in after);
    await setManualClassification(environment, 'TEST', 'EXCHANGE', '검증된 관리값');
    assert.equal((await (await request()).json()).company.analysisProfile.type, 'EXCHANGE');
  } finally { sqlite.close(); }
});

test('P9B 승인 UI 분리 외 GENERAL 코드와 SEC 재무 계산은 checkpoint와 동일하다', async () => {
  const { execFileSync } = await import('node:child_process');
  const baseline = filename => execFileSync('git', ['show', `9c524367c404338e097dd5a5e2f7975f44f9fd70:${filename}`], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
  const current = filename => readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // P1 당시의 UI 전체 동결은 P9B의 명시적인 UI 변경 승인으로 끝났다. 계산과 GENERAL shell 보호는 유지한다.
  assert.equal(current('worker/src/sec-financial-metadata.js'), baseline('worker/src/sec-financial-metadata.js'));
  assert.equal(current('financial-chart.js').replace('Object.freeze({ loadLibrary, financialMetricConfigs', 'Object.freeze({ financialMetricConfigs'), baseline('financial-chart.js'));
  assert.equal(current('app.js').replaceAll('globalThis.FinancialPanel', 'globalThis.FinancialChart'), baseline('app.js'));
  const generalShell = text => text.slice(text.indexOf('<nav class="financial-metric-selector"'), text.indexOf('</section>', text.indexOf('<nav class="financial-metric-selector"')));
  assert.equal(generalShell(current('index.html')), generalShell(baseline('index.html')));
  const reitCssStart = current('style.css').indexOf('/* 긴 공시 정의 버전');
  const reitCssEnd = current('style.css').indexOf('@media (max-width: 600px)', reitCssStart);
  assert.equal(current('style.css').slice(0, reitCssStart) + current('style.css').slice(reitCssEnd), baseline('style.css'));
});
