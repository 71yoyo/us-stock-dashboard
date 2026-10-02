import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extractStandardRawMetrics, deriveStandardMetric, STANDARD_RAW_METRICS } from '../worker/src/sec-standard-raw.js';
import { saveStandardRawMetrics, queryStandardRawMetrics, assertStandardRawSchema } from '../worker/src/sec-standard-raw-store.js';
import { syncFinancialsFromSec } from '../worker/src/fmp-sync.js';
import { createMetricTestDatabase, seedProtectedMetrics, protectedDigest } from './helpers/specialized-metrics-db.js';
import { addFact, secFact, oR2Facts, oR2, syntheticCompanyFacts, companies } from './helpers/sec-standard-raw-fixtures.js';

const migration = readFileSync(new URL('../worker/migrations/0020_sec_standard_raw_metrics.sql', import.meta.url), 'utf8');
const extract = facts => extractStandardRawMetrics(facts, { minimumYear: 2016 });
const row = (rows, name, type = 'annual', end = '2025-12-31') => rows.find(item => item.metricName === name
  && item.periodType === type && item.periodEnd === end);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const numericSnapshot = sqlite => sqlite.prepare(`SELECT ticker,period_type,fiscal_period_end,
  revenue,operating_income,net_income,eps,free_cash_flow,roe,roic,gross_margin,operating_margin,
  peg_ratio,pe_ratio,ps_ratio,fiscal_year,fiscal_period,period_start FROM financial_metrics
  ORDER BY ticker,period_type,fiscal_period_end`).all();
const rawSnapshot = sqlite => ['sec_standard_raw_metrics','sec_standard_raw_provenance']
  .map(table => sqlite.prepare(`SELECT * FROM ${table} ORDER BY ticker,metric_name,period_type,period_start,period_end`).all());

test('R3 fresh migration 0001~0020 적용 및 additive-only 테이블/인덱스', () => {
  const { sqlite } = createMetricTestDatabase();
  try {
    assert.ok(!/\b(?:ALTER|DROP|UPDATE|DELETE)\s+(?:TABLE|FROM|financial_metrics|company_classification)/i.test(migration));
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'sec_standard_raw_%' AND type='table'").get().n, 2);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { sqlite.close(); }
});

test('R3 existing 0019→0020는 기존 숫자/분류/출처 전체를 변경하지 않는다', () => {
  const { sqlite } = createMetricTestDatabase(true, 19);
  try {
    seedProtectedMetrics(sqlite);
    const before = protectedDigest(sqlite);
    sqlite.prepare(`INSERT INTO financial_metric_provenance(ticker,period_type,fiscal_period_end,
      metric_name,calculation_type,source_refs_json,metric_value) VALUES ('O','annual','2025-12-31',
      'stockholders_equity','direct','[]',42)`).run();
    const provenance = sqlite.prepare('SELECT * FROM financial_metric_provenance').all();
    sqlite.exec(migration);
    assert.equal(protectedDigest(sqlite), before);
    assert.deepEqual(sqlite.prepare('SELECT * FROM financial_metric_provenance').all(), provenance);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { sqlite.close(); }
});

test('R3 migration 누락은 기존 재무 쓰기 전 safe-fail', async () => {
  const { sqlite, DB } = createMetricTestDatabase(true, 19);
  try {
    sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','TEST')");
    await assert.rejects(syncFinancialsFromSec({ DB, secFacts: new Map([['O',oR2Facts()]]),
      SEC_STANDARD_RAW_FIELDS_ENABLED: 'true' }, 'O'), /migration 0020/);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM financial_metrics').get().n, 0);
  } finally { sqlite.close(); }
});

for (const [name, definition] of Object.entries(STANDARD_RAW_METRICS).filter(([, value]) => value.tags.length)) {
  test(`R3 O R2 ${name}: 정확한 unit/value와 DB provenance round-trip`, async () => {
    const { sqlite, DB } = createMetricTestDatabase();
    try {
      sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','TEST')");
      const records = extract(oR2Facts());
      await saveStandardRawMetrics(DB, 'O', records);
      const type = definition.kind === 'point_in_time' ? 'instant' : 'annual';
      const saved = (await queryStandardRawMetrics(DB, 'O', type)).find(item => item.metric_name === name && item.period_end === '2025-12-31');
      assert.equal(saved.metric_value, oR2.annual.values[definition.tags[0]]);
      assert.equal(saved.unit, definition.unit);
      assert.equal(saved.entity_scope, definition.scope);
      assert.equal(saved.sec_tag, definition.tags[0]);
      assert.equal(saved.form, '10-K');
      assert.equal(saved.accession_number, oR2.annual.accn);
      assert.equal(saved.filed_date, oR2.annual.filed);
      assert.equal(saved.source_start, type === 'instant' ? null : oR2.annual.start);
      assert.equal(saved.source_end, oR2.annual.end);
      assert.equal(saved.sourceRefs[0].value, saved.metric_value);
      assert.equal(saved.sourceRefs[0].entity_scope, definition.scope);
      assert.equal(saved.source_fingerprint.length, 64);
    } finally { sqlite.close(); }
  });
}

test('R3 시점 잔액은 start 없는 instant로만 저장: annual/quarterly 합계가 아님', () => {
  const records = extract(oR2Facts());
  const cash = row(records, 'cash_and_cash_equivalents', 'instant', '2026-06-30');
  assert.equal(cash.periodStart, '');
  assert.equal(cash.metricValue, 552648000);
  assert.equal(row(records, 'cash_and_cash_equivalents', 'annual'), undefined);
  assert.equal(records.filter(item => item.metricName === 'cash_and_cash_equivalents').length, 2);
});

test('R3 parent equity와 NCI 포함 equity는 각각 보존하며 fallback 혼합 금지', () => {
  const records = extract(oR2Facts());
  const parent = row(records, 'stockholders_equity', 'instant');
  const inclusive = row(records, 'equity_including_nci', 'instant');
  assert.equal(inclusive.metricValue - parent.metricValue, 685273000);
  assert.equal(inclusive.metricValue, oR2.bqCrossCheck['Common Equity (Annual)']);
  const facts = oR2Facts(); delete facts['us-gaap'].StockholdersEquity;
  assert.equal(row(extract(facts), 'stockholders_equity', 'instant').metricValue, null);
});

test('R3 실제 주식 수와 basic/diluted 평균은 BQ 명칭과 무관하게 구분한다', () => {
  const records = extract(oR2Facts());
  assert.equal(row(records, 'shares_outstanding', 'instant').metricValue, 933975000);
  assert.equal(row(records, 'weighted_average_shares_basic').metricValue, 907169000);
  assert.equal(row(records, 'weighted_average_shares_diluted').metricValue, 908334000);
});

test('R3 DEI 실제 날짜를 보존하고 cover-page 값을 분기 말로 이동하지 않는다', () => {
  const facts = oR2Facts();
  addFact(facts, 'EntityCommonStockSharesOutstanding', secFact(null, '2026-07-30', 946218033,
    { filed: '2026-08-06', form: '10-Q', fp: 'Q2', accn: 'synthetic-dei' }), 'shares', 'dei');
  const records = extract(facts);
  assert.equal(row(records,'shares_outstanding','instant','2026-06-30').metricValue, 946202000);
  const cover = row(records,'shares_outstanding','instant','2026-07-30');
  assert.equal(cover.metricValue, 946218033);
  assert.equal(cover.provenance.sourceRefs[0].taxonomy, 'dei');
  assert.equal(cover.provenance.calculationDetails.shareBasis, 'cover_page_actual_date');
});

test('R3 같은 날짜/제출일의 실제 주식 수는 us-gaap 우선이며 평균값은 대체 불가', () => {
  const facts = oR2Facts();
  addFact(facts,'EntityCommonStockSharesOutstanding',secFact(null,'2025-12-31',999), 'shares','dei');
  assert.equal(row(extract(facts),'shares_outstanding','instant').metricValue, 933975000);
  delete facts['us-gaap'].CommonStockSharesOutstanding; delete facts.dei;
  assert.equal(row(extract(facts),'shares_outstanding','instant').metricValue, null);
});

test('R3 오래된 InterestExpense가 최신 InterestExpenseOperating 선택을 막지 않는다', () => {
  const facts = oR2Facts();
  addFact(facts,'InterestExpense',secFact('2024-01-01','2024-09-30',748806000,
    { form:'10-Q',fp:'Q3',filed:'2024-11-05',accn:'synthetic-old' }));
  const selected = row(extract(facts),'interest_expense');
  assert.equal(selected.metricValue,1134879000);
  assert.equal(selected.provenance.secTag,'InterestExpenseOperating');
});

test('R3 동일 기간 InterestExpense fallback과 같은 제출일 Operating 우선순위', () => {
  const facts = oR2Facts();
  addFact(facts,'InterestExpense',secFact('2025-01-01','2025-12-31',123));
  assert.equal(row(extract(facts),'interest_expense').metricValue,1134879000);
  delete facts['us-gaap'].InterestExpenseOperating;
  assert.equal(row(extract(facts),'interest_expense').metricValue,123);
});

test('R3 동일 기간의 최신 제출값을 선택하고 같은 순위의 값 충돌은 NULL', () => {
  const facts = oR2Facts();
  addFact(facts,'InterestExpense',secFact('2025-01-01','2025-12-31',123,
    { form:'10-K/A',filed:'2026-03-01',accn:'synthetic-revised' }));
  assert.equal(row(extract(facts),'interest_expense').metricValue,123);
  addFact(facts,'InterestExpense',secFact('2025-01-01','2025-12-31',124,
    { form:'10-K/A',filed:'2026-03-01',accn:'synthetic-revised' }));
  assert.equal(row(extract(facts),'interest_expense').metricValue,null);
});

test('R3 YTD 평균 주식 수는 단순 차감하거나 연간/standalone 값으로 오용하지 않는다', () => {
  const facts = oR2Facts();
  addFact(facts,'WeightedAverageNumberOfSharesOutstandingBasic',secFact('2026-01-01','2026-03-31',900000000,
    { form:'10-Q',fp:'Q2',filed:'2026-08-06',accn:oR2.ytd.accn }), 'shares');
  const records = extract(facts);
  assert.equal(row(records,'weighted_average_shares_basic','quarterly','2026-06-30')?.metricValue ?? null,null);
  assert.equal(row(records,'weighted_average_shares_basic','ytd','2026-06-30').metricValue,null);
  assert.equal(row(records,'weighted_average_shares_basic').metricValue,907169000);
});

test('R3 가중평균 주식 수는 직접 standalone Q2 값만 저장한다', () => {
  const facts = oR2Facts();
  addFact(facts,'WeightedAverageNumberOfSharesOutstandingBasic',secFact('2026-04-01','2026-06-30',940000000,
    { form:'10-Q',fp:'Q2',filed:'2026-08-06',accn:oR2.ytd.accn }), 'shares');
  const direct = row(extract(facts),'weighted_average_shares_basic','quarterly','2026-06-30');
  assert.equal(direct.metricValue,940000000);
  assert.equal(direct.provenance.calculationType,'direct');
});

test('R3 기간 합계는 같은 accession 누적 차감으로 Q2를 만들고 두 원본을 보존한다', () => {
  const facts = oR2Facts();
  addFact(facts,'InterestExpenseOperating',secFact('2026-01-01','2026-03-31',300000000,
    { form:'10-Q',fp:'Q2',filed:'2026-08-06',accn:oR2.ytd.accn }));
  const result = row(extract(facts),'interest_expense','quarterly','2026-06-30');
  assert.equal(result.metricValue,304023000);
  assert.equal(result.periodStart,'2026-04-01');
  assert.equal(result.provenance.calculationType,'ytd_difference');
  assert.deepEqual(result.provenance.sourceRefs.map(ref=>ref.value),[604023000,300000000]);
});

test('R3 공시 버전이 다른 YTD를 차감해 분기 값을 생성하지 않는다', () => {
  const facts = oR2Facts();
  addFact(facts,'InterestExpenseOperating',secFact('2026-01-01','2026-03-31',300000000,
    { form:'10-Q',fp:'Q1',filed:'2026-05-05',accn:'synthetic-q1-other' }));
  assert.equal(row(extract(facts),'interest_expense','quarterly','2026-06-30')?.metricValue ?? null,null);
});

test('R3 FY minus 9m는 합계만허용, Q4 시작일과차감근거 유지', () => {
  const facts = oR2Facts();
  addFact(facts,'InterestExpenseOperating',secFact('2025-01-01','2025-09-30',800000000,
    { ...oR2.annual, values:undefined, val:800000000, end:'2025-09-30' }));
  const q4 = row(extract(facts),'interest_expense','quarterly');
  assert.equal(q4.metricValue,334879000);
  assert.equal(q4.periodStart,'2025-10-01');
  assert.equal(q4.provenance.calculationType,'fy_minus_9m');
  assert.equal(row(extract(facts),'weighted_average_shares_basic','quarterly')?.metricValue ?? null,null);
});

test('R3 직접quarter 값은 추정누적차감보다 우선', () => {
  const facts = oR2Facts();
  const context = { form:'10-Q',fp:'Q2',filed:'2026-08-06',accn:oR2.ytd.accn };
  addFact(facts,'InterestExpenseOperating',secFact('2026-01-01','2026-03-31',300000000,context));
  addFact(facts,'InterestExpenseOperating',secFact('2026-04-01','2026-06-30',305000000,context));
  const selected = row(extract(facts),'interest_expense','quarterly','2026-06-30');
  assert.equal(selected.metricValue,305000000);
  assert.equal(selected.provenance.calculationType,'direct');
});

test('R3 같은 공시의 Q2 누적 차감 입력으로 EBIT/EBITDA를 일관되게 계산한다', () => {
  const facts=oR2Facts();
  const context={form:'10-Q',fp:'Q2',fy:2026,filed:'2026-08-06',accn:oR2.ytd.accn};
  for(const [tag,value] of [['ProfitLoss',300000000],['IncomeTaxExpenseBenefit',20000000],
    ['InterestExpenseOperating',300000000],['DepreciationDepletionAndAmortization',600000000]]) {
    addFact(facts,tag,secFact('2026-01-01','2026-03-31',value,context));
  }
  const records=extract(facts);
  assert.equal(row(records,'ebit','quarterly','2026-06-30').metricValue,727474000);
  assert.equal(row(records,'ebitda','quarterly','2026-06-30').metricValue,1402426000);
  assert.ok(row(records,'ebit','quarterly','2026-06-30').provenance.calculationDetails.inputs
    .every(input=>input.calculationType==='ytd_difference'));
});

test('R3 비달력 회사의 직접 분기는 원본 FY2027/Q2를 사용한다', () => {
  const facts={};
  addFact(facts,'WeightedAverageNumberOfSharesOutstandingBasic',secFact('2026-04-27','2026-07-26',123,
    {form:'10-Q',fy:2027,fp:'Q2',filed:'2026-08-26',accn:'synthetic-noncalendar'}),'shares');
  const selected=row(extract(facts),'weighted_average_shares_basic','quarterly','2026-07-26');
  assert.equal(selected.fiscalYear,2027);
  assert.equal(selected.fiscalPeriod,'Q2');
  assert.equal(selected.periodStart,'2026-04-27');
});

for (const [name, expected] of Object.entries(oR2.expectedDerived)) {
  test(`R3 O FY2025 ${name}: R2/BQ exact match와파생입력 보존`, () => {
    const selected = row(extract(oR2Facts()),name);
    assert.equal(selected.metricValue,expected);
    assert.equal(selected.entityScope,'consolidated');
    assert.equal(selected.provenance.calculationType,'derived');
    assert.equal(selected.provenance.sourceRefs.find(ref=>ref.tag==='ProfitLoss').value,1069783000);
    assert.ok(!selected.provenance.sourceRefs.some(ref=>ref.tag==='NetIncomeLoss'));
    assert.ok(selected.provenance.calculationDetails.inputs.every(input=>Number.isFinite(input.value)));
  });
}

for (const tag of ['ProfitLoss','IncomeTaxExpenseBenefit','InterestExpenseOperating','DepreciationDepletionAndAmortization']) {
  test(`R3 missing input ${tag}는0채움 없이 derived NULL`, () => {
    const facts = oR2Facts(); delete facts['us-gaap'][tag];
    const result = extract(facts);
    assert.equal(row(result,'ebitda').metricValue,null);
    if(tag!=='DepreciationDepletionAndAmortization') assert.equal(row(result,'ebit').metricValue,null);
  });
}

for (const mismatch of ['start','end','scope','unit','accession']) {
  test(`R3 derived ${mismatch} mismatch는needs_review/NULL`, () => {
    const records = extract(oR2Facts());
    const inputs = ['consolidated_net_income','income_tax_expense','interest_expense'].map(name=>structuredClone(row(records,name)));
    if(mismatch==='start') inputs[1].periodStart='2025-01-02';
    if(mismatch==='end') inputs[1].periodEnd='2025-12-30';
    if(mismatch==='scope') inputs[1].entityScope='parent';
    if(mismatch==='unit') inputs[1].unit='shares';
    if(mismatch==='accession') inputs[1].provenance.sourceRefs[0].accession='different-filing';
    const derived = deriveStandardMetric('ebit',{type:'annual',start:'2025-01-01',end:'2025-12-31'},inputs);
    assert.equal(derived.availability,'needs_review');
    assert.equal(derived.metricValue,null);
  });
}

test('R3 음수/0 원본을 보존하고 다른 연도/기간을 혼합하지 않는다', () => {
  const facts = oR2Facts();
  facts['us-gaap'].ProfitLoss.units.USD[0].val=-100;
  facts['us-gaap'].IncomeTaxExpenseBenefit.units.USD[0].val=0;
  assert.equal(row(extract(facts),'consolidated_net_income').metricValue,-100);
  assert.equal(row(extract(facts),'income_tax_expense').metricValue,0);
  assert.equal(row(extract(facts),'ebit').metricValue,1134878900);
  facts['us-gaap'].InterestExpenseOperating.units.USD[0].start='2025-01-02';
  assert.equal(row(extract(facts),'ebit').metricValue,null);
});

test('R3 잘못된 단위/날짜/숫자형/segment는 raw 값으로 채택하지 않는다', () => {
  const facts = oR2Facts();
  const cash = facts['us-gaap'].CashAndCashEquivalentsAtCarryingValue;
  cash.units.USD[0].val='434842000';
  addFact(facts,'CashAndCashEquivalentsAtCarryingValue',secFact(null,'2025-12-31',999),'EUR');
  addFact(facts,'CashAndCashEquivalentsAtCarryingValue',secFact(null,'2025-12-31',999,{segment:'SUBSIDIARY'}));
  assert.equal(row(extract(facts),'cash_and_cash_equivalents','instant').metricValue,null);
});

test('R3 현금에 restricted-inclusive 값을 fallback으로 사용하지 않는다', () => {
  const facts = oR2Facts(); delete facts['us-gaap'].CashAndCashEquivalentsAtCarryingValue;
  addFact(facts,'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',secFact(null,'2025-12-31',520756000));
  assert.equal(row(extract(facts),'cash_and_cash_equivalents','instant').metricValue,null);
});

test('R3 누락/충돌을 포함한 DB round-trip과 idempotency, 기존 provenance 불변', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    seedProtectedMetrics(sqlite);
    const before = protectedDigest(sqlite);
    const prior = sqlite.prepare('SELECT * FROM financial_metric_provenance').all();
    const records = extract(oR2Facts());
    await saveStandardRawMetrics(DB,'O',records);
    const snapshot = rawSnapshot(sqlite);
    await saveStandardRawMetrics(DB,'O',records);
    assert.deepEqual(rawSnapshot(sqlite),snapshot);
    assert.equal(protectedDigest(sqlite),before);
    assert.deepEqual(sqlite.prepare('SELECT * FROM financial_metric_provenance').all(),prior);
    const saved = (await queryStandardRawMetrics(DB,'O','annual')).find(item=>item.metric_name==='ebitda');
    assert.equal(saved.metric_value,4814208000);
    assert.deepEqual(saved.calculationDetails,row(records,'ebitda').provenance.calculationDetails);
    assert.deepEqual(saved.sourceRefs,row(records,'ebitda').provenance.sourceRefs);
  } finally { sqlite.close(); }
});

test('R3 정정값은 이전 provenance를 보존하며 동일 값 재저장은 변경 0건', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','TEST')");
    const facts = oR2Facts();
    await saveStandardRawMetrics(DB,'O',extract(facts));
    const before = sqlite.prepare('SELECT * FROM sec_standard_raw_provenance').all();
    facts['us-gaap'].CashAndCashEquivalentsAtCarryingValue.units.USD[0].val+=1;
    await saveStandardRawMetrics(DB,'O',extract(facts));
    const after = sqlite.prepare('SELECT * FROM sec_standard_raw_provenance').all();
    assert.equal(after.length,before.length+1);
    assert.ok(before.every(old=>after.some(saved=>saved.source_fingerprint===old.source_fingerprint)));
    const changesBefore = sqlite.prepare('SELECT total_changes() n').get().n;
    await saveStandardRawMetrics(DB,'O',extract(facts));
    assert.equal(sqlite.prepare('SELECT total_changes() n').get().n,changesBefore);
  } finally { sqlite.close(); }
});

test('R3 provenance 저장 중 실패하면 raw 값도 트랜잭션 rollback', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','TEST')");
    sqlite.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON sec_standard_raw_provenance
      BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FAILURE'); END`);
    await assert.rejects(saveStandardRawMetrics(DB,'O',extract(oR2Facts())),/SYNTHETIC_FAILURE/);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_metrics').get().n,0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_provenance').get().n,0);
  } finally { sqlite.close(); }
});

test('R3 저장기는 debt/EV, 중복, 평균 차감, provenance 누락을 거부한다', async () => {
  const { sqlite, DB } = createMetricTestDatabase();
  try {
    sqlite.exec("INSERT INTO companies(ticker,name) VALUES ('O','TEST')");
    const records=extract(oR2Facts()), average=structuredClone(row(records,'weighted_average_shares_basic'));
    await assert.rejects(saveStandardRawMetrics(DB,'O',[{...average,metricName:'total_debt'}]),/유효/);
    await assert.rejects(saveStandardRawMetrics(DB,'O',[average,average]),/중복/);
    average.provenance.calculationType='ytd_difference';
    await assert.rejects(saveStandardRawMetrics(DB,'O',[average]),/가중평균/);
    average.provenance=null;
    await assert.rejects(saveStandardRawMetrics(DB,'O',[average]),/provenance/);
    await assert.rejects(queryStandardRawMetrics(DB,'O','invalid'),/유효/);
  } finally { sqlite.close(); }
});

test('R3 순수 추출은 payload를 변경하지 않고 ticker/API/network에 의존하지 않는다', t => {
  t.mock.method(globalThis,'fetch',()=>{throw new Error('외부 호출 금지');});
  const facts=oR2Facts(), before=hash(facts);
  extract(facts);
  assert.equal(hash(facts),before);
  const source=readFileSync(new URL('../worker/src/sec-standard-raw.js',import.meta.url),'utf8');
  assert.ok(!/fetch\(|\b(?:O|JPM|NVDA)\b\s*[:=]/.test(source));
  assert.deepEqual(extract({}),[]);
});

test('R3 손상된 units 배열/빈 fact를 안전하게 제외한다', () => {
  const facts=oR2Facts();
  facts['us-gaap'].Assets.units.USD={broken:true};
  facts['us-gaap'].InterestExpenseOperating.units.USD.push(null);
  assert.equal(row(extract(facts),'total_assets','instant').metricValue,null);
  assert.equal(row(extract(facts),'interest_expense').metricValue,1134879000);
});

test('R3 파생 입력 지표 수/이름을 바꿔 formula와 다른 값으로 저장하지 않는다', () => {
  const records=extract(oR2Facts());
  const period={type:'annual',start:'2025-01-01',end:'2025-12-31'};
  const inputs=['consolidated_net_income','income_tax_expense','interest_expense'].map(name=>row(records,name));
  assert.equal(deriveStandardMetric('ebit',period,inputs.slice(1)).metricValue,null);
  assert.equal(deriveStandardMetric('ebit',period,[inputs[0],inputs[0],inputs[2]]).metricValue,null);
  assert.throws(()=>deriveStandardMetric('market_cap',period,inputs),/지원하지 않는/);
});

test('R3 저장기는 실제 없는 날짜와 잘못된 행 배열을 DB 쓰기 전 거부한다', async () => {
  const {sqlite,DB}=createMetricTestDatabase();
  try {
    const valid=structuredClone(row(extract(oR2Facts()),'interest_expense'));
    valid.periodEnd='2025-02-30';
    await assert.rejects(saveStandardRawMetrics(DB,'O',[valid]),/유효/);
    await assert.rejects(saveStandardRawMetrics(DB,'O',null),/배열/);
    await assert.rejects(saveStandardRawMetrics(DB,'O',[null]),/유효/);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_metrics').get().n,0);
  } finally {sqlite.close();}
});

test('R3 기존sync 한 SEC 응답만사용하며 flag off/on public result와numeric동일', async t => {
  const { sqlite, DB }=createMetricTestDatabase();
  try {
    sqlite.exec("INSERT INTO companies(ticker,name,cik) VALUES ('O','TEST','726728')");
    let calls=0;
    t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({facts:oR2Facts()});});
    const oldResult=await syncFinancialsFromSec({DB},'O');
    assert.equal(calls,1);
    const before=numericSnapshot(sqlite);
    calls=0;
    const newResult=await syncFinancialsFromSec({DB,SEC_STANDARD_RAW_FIELDS_ENABLED:'true'},'O');
    assert.equal(calls,1);
    assert.deepEqual(newResult,oldResult);
    assert.deepEqual(numericSnapshot(sqlite),before);
    assert.ok(sqlite.prepare('SELECT COUNT(*) n FROM sec_standard_raw_metrics').get().n>0);
  } finally {sqlite.close();}
});

test('R3 10종목 GENERAL/BANK/REIT 합성fixture:기존500행 numeric digest불변', async t => {
  t.mock.method(globalThis,'fetch',()=>{throw new Error('외부 호출 금지');});
  const {sqlite,DB}=createMetricTestDatabase();
  try {
    const fixtures=new Map();
    for(const company of companies){
      sqlite.prepare('INSERT INTO companies(ticker,name) VALUES (?,?)').run(company.ticker,company.ticker);
      fixtures.set(company.ticker,syntheticCompanyFacts({missingMetrics:company.ticker==='JPM'
        ? ['interest_expense','depreciation_and_amortization'] : []}));
      await syncFinancialsFromSec({DB,secFacts:fixtures},company.ticker);
    }
    const before=numericSnapshot(sqlite);
    assert.equal(before.length,500);
    for(const company of companies)await syncFinancialsFromSec({DB,secFacts:fixtures,
      SEC_STANDARD_RAW_FIELDS_ENABLED:'true'},company.ticker);
    assert.equal(hash(numericSnapshot(sqlite)),hash(before));
    assert.equal(sqlite.prepare('SELECT COUNT(DISTINCT ticker) n FROM sec_standard_raw_metrics').get().n,10);
    assert.ok(sqlite.prepare("SELECT COUNT(*) n FROM sec_standard_raw_metrics WHERE ticker='JPM' AND availability='missing'").get().n>0);
    await assertStandardRawSchema(DB);
  } finally {sqlite.close();}
});
