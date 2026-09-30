import test from 'node:test';
import assert from 'node:assert/strict';
import { difference, normalizeBusinessQuant, compareBusinessQuant, inspectRawSec, reprocessSec } from '../scripts/sec-financial-audit.mjs';

// 검증 도구 자체의 테스트 자료다. 실제 NVDA 원본이나 외부 API 응답이라고 표시하지 않는다.
const section = (name, raw, date = '2026-01-25') => ({ metadata: { name },
  values: [{ date, normalizedDate: '2025-12-31', periodType: 'Annual', reportedValue: { raw } }] });
const payload = sections => ({ data: { group: { sections } } });

test('검증용 비교는 NULL과 0을 구분하고 금액 차이를 유지한다', () => {
  assert.equal(difference(0, 0).status, 'MATCH');
  assert.equal(difference(null, 0).status, 'MISSING');
  assert.equal(difference(100, 100.05).status, 'SMALL DIFFERENCE');
  assert.equal(difference(100, 102).status, 'MATERIAL DIFFERENCE');
});

test('BQ 연간 EPS 괄호 이름도 희석 EPS로 읽고 basic을 대신 사용하지 않는다', () => {
  const result = normalizeBusinessQuant(payload({ basic: section('EPS (Basic) (Annual)', 5),
    diluted: section('EPS (Diluted) (Annual)', 4.8979) }));
  assert.equal(result.periods[0].eps, 4.8979);
  assert.equal(result.periods[0].definitions.eps, 'EPS (Diluted) (Annual)');
});

test('외부 API의 normalizedDate나 월로 FY/Q를 생성하지 않는다', () => {
  const row = normalizeBusinessQuant(payload({ revenue: section('Revenue (Annual)', 100) })).periods[0];
  assert.equal(row.end, '2026-01-25');
  assert.equal(row.normalizedDate, '2025-12-31');
  assert.equal(row.fiscalYear, null);
  assert.equal(row.fiscalPeriod, null);
});

test('마진은 검증 도구에서만 계산하고 원본 수치는 변경하지 않는다', () => {
  const row = normalizeBusinessQuant(payload({ revenue: section('Revenue (Annual)', 100),
    gross: section('Gross Profit (Annual)', 75), net: section('Net Income (Annual)', 20) })).periods[0];
  assert.equal(row.gross_margin, 75);
  assert.equal(row.net_margin, 20);
  assert.equal(row.net_income, 20);
});

test('BQ 현금흐름의 명시적 필드 Cash from Operations를 읽는다', () => {
  const row = normalizeBusinessQuant(payload({ cash: section('Cash from Operations (Annual)', 30) })).periods[0];
  assert.equal(row.operating_cash_flow, 30);
});

test('IS·CF 비교 결합은 순이익 출처를 바꾸지 않으며 EPS 반올림을 별도로 표시한다', () => {
  const comparisons = compareBusinessQuant([{ period_type: 'annual', fiscal_period_end: '2026-01-25',
    fiscal_year: 2026, fiscal_period: 'FY', net_income: 20, eps: 4.9, free_cash_flow: 30 }], [
    { frequency: 'Annual', statement: 'IS', periods: [{ end: '2026-01-25', net_income: 20, eps: 4.8979 }] },
    { frequency: 'Annual', statement: 'CF', periods: [{ end: '2026-01-25', net_income: 19, free_cash_flow: 30 }] }
  ]);
  assert.equal(comparisons.find(row => row.metric === 'net_income').status, 'MATCH');
  assert.equal(comparisons.find(row => row.metric === 'eps').status, 'ROUNDING');
  assert.equal(comparisons.find(row => row.metric === 'free_cash_flow').status, 'MATCH');
});

test('실제 구조 검사는 units 키를 단위로 보존하고 오래된 수정 공시를 보고만 한다', () => {
  const inspected = inspectRawSec({ facts: { 'us-gaap': { Revenues: { units: { USD: [{
    start: '2012-01-01', end: '2012-03-31', filed: '2012-08-09', form: '10-Q/A',
    fp: 'Q1', fy: 2012, accn: 'fixture', val: 1
  }] } } } } });
  assert.equal(inspected.populatedFields.unit, 1);
  assert.equal(inspected.delayedFilings[0].days, 131);
});

test('검증 재처리는 메모리 DB만 사용하고 빈 입력·외부 API 자료는 거부한다', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('테스트에서 외부 API 요청 금지'); });
  await assert.rejects(reprocessSec({ data: {} }), /US-GAAP/);
  const result = await reprocessSec({ cik: 1, facts: { 'us-gaap': { Revenues: { units: { USD: [{
    start: '2025-01-27', end: '2026-01-25', filed: '2026-02-25', form: '10-K',
    fp: 'FY', fy: 2026, accn: 'fixture', val: 100
  }] } } } } }, 'TEST');
  assert.equal(result.coverage.find(row => row.period_type === 'annual').fiscalYear, 1);
  assert.equal(result.rows.find(row => row.period_type === 'annual').revenue, 100);
  assert.equal(result.provenanceCount, 1);
});
