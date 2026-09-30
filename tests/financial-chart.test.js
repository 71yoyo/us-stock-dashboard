import test from 'node:test';
import assert from 'node:assert/strict';
import '../financial-chart.js';

const chart = globalThis.FinancialChart;
const annual = (year, revenue = 100, netIncome = 25) => ({ periodType: 'annual', fiscalYear: year,
  fiscalPeriod: 'FY', fiscalPeriodEnd: `${year}-12-31`, periodStart: `${year}-01-01`,
  reportedDate: `${year + 1}-02-01`, revenue, netIncome });
const quarter = (year, period, end, revenue = 100, netIncome = 25) => ({ periodType: 'quarterly',
  fiscalYear: year, fiscalPeriod: period, fiscalPeriodEnd: end, revenue, netIncome });

test('달력 연도 대신 SEC fiscalYear의 FY를 쓰고 오래된 순으로 정렬하며 원본을 변경하지 않는다', () => {
  const input = [annual(2025), { ...annual(2024), fiscalPeriodEnd: '2025-01-26' }, quarter(2025, 'Q1', '2025-03-31')];
  const before = JSON.stringify(input);
  const rows = chart.prepareFinancialData(input, 'annual');
  assert.deepEqual(rows.map(row => row.label), ['FY2024', 'FY2025']);
  assert.equal(JSON.stringify(input), before);
});

test('분기는 calendar month 대신 FY/Q metadata로 라벨링하고 오래된 순으로 정렬한다', () => {
  const rows = chart.prepareFinancialData([quarter(2027, 'Q2', '2026-07-26'),
    quarter(2027, 'Q1', '2026-04-26'), annual(2026)], 'quarterly');
  assert.deepEqual(rows.map(row => row.label), ['Q1 FY2027', 'Q2 FY2027']);
});

test('FY/Q metadata가 없으면 기간을 달력 날짜로 추측하지 않는다', () => {
  const rows = chart.prepareFinancialData([{ periodType: 'quarterly', fiscalPeriodEnd: '2026-07-26', revenue: 5, netIncome: 1 }], 'quarterly');
  assert.equal(rows[0].label, '기간 미확보');
  assert.equal(rows[0].revenueQoQ, null);
});

test('순마진은 같은 행의 순이익/매출이며 NVDA 실제 값은 반올림해 62.03%다', () => {
  assert.equal(chart.netMargin(96221000000, 59688000000), 59688000000 / 96221000000 * 100);
  assert.equal(chart.formatPercent(chart.netMargin(96221000000, 59688000000)), '62.03%');
});

test('매출 0·누락·빈 문자열 또는 순이익 누락은 순마진 null이며 실제 순이익 0은 0%다', () => {
  for (const sales of [0, null, undefined, '', NaN, Infinity]) assert.equal(chart.netMargin(sales, 5), null);
  for (const income of [null, undefined, '', NaN]) assert.equal(chart.netMargin(5, income), null);
  assert.equal(chart.netMargin(5, 0), 0);
});

test('변화율은 이전 값의 절댓값으로 나누며 이전 0/누락과 Infinity를 출력하지 않는다', () => {
  assert.equal(chart.percentageChange(120, 100), 20);
  assert.equal(chart.percentageChange(-50, -100), 50);
  assert.equal(chart.percentageChange(10, 0), null);
  assert.equal(chart.percentageChange(10, null), null);
  assert.equal(chart.percentageChange(Number.MAX_VALUE, Number.MIN_VALUE), null);
});

test('연간 YoY는 같은 회계연도의 전년만 비교하고 누락 연도를 뛰어넘지 않는다', () => {
  const rows = chart.prepareFinancialData([annual(2021, 100, -100), annual(2022, 120, -50), annual(2024, 180, 100)], 'annual');
  assert.equal(rows[1].revenueYoY, 20);
  assert.equal(rows[1].incomeYoY, 50);
  assert.equal(rows[2].revenueYoY, null);
});

test('분기 QoQ는 FY 경계의 Q4→Q1을 비교한다', () => {
  const rows = chart.prepareFinancialData([quarter(2025, 'Q4', '2025-01-26', 100, 20),
    quarter(2026, 'Q1', '2025-04-26', 120, 10)], 'quarterly');
  assert.equal(rows[1].revenueQoQ, 20);
  assert.equal(rows[1].incomeQoQ, -50);
});

test('분기 YoY는 배열 4칸이 아니라 같은 fiscalPeriod의 이전 fiscalYear로 비교한다', () => {
  const rows = chart.prepareFinancialData([quarter(2026, 'Q2', '2025-07-26', 80, 20),
    quarter(2027, 'Q1', '2026-04-26', 90, 30), quarter(2027, 'Q2', '2026-07-26', 100, 40)], 'quarterly');
  assert.equal(rows[2].revenueYoY, 25);
  assert.equal(rows[2].incomeYoY, 100);
  assert.ok(Math.abs(rows[2].revenueQoQ - 100 / 9) < 1e-10);
});

test('분기가 빠지면 이전 행을 전분기로 임의 취급하지 않는다', () => {
  const rows = chart.prepareFinancialData([quarter(2027, 'Q1', '2026-04-26'), quarter(2027, 'Q3', '2026-10-26')], 'quarterly');
  assert.equal(rows[1].revenueQoQ, null);
});

for (const [range, expected] of [['8', 8], ['12', 12], ['20', 20], ['all', 40]]) {
  test(`분기 ${range} 범위는 최근 ${expected}개를 오름차순으로 유지한다`, () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ index }));
    const selected = chart.selectRange(rows, 'quarterly', range);
    assert.equal(selected.length, expected);
    assert.equal(selected[0].index, 40 - expected);
    assert.equal(selected.at(-1).index, 39);
  });
}

test('연간은 최근 10 fiscal years를 사용하며 부족한 이력을 만들어 채우지 않는다', () => {
  assert.equal(chart.selectRange(Array.from({ length: 12 }, (_, index) => index), 'annual')[0], 2);
  assert.equal(chart.selectRange([1, 2], 'annual').length, 2);
});

test('콤보 차트는 나란한 bar 2개와 오른쪽 Y축 line이며 null·음수를 그대로 둔다', () => {
  const rows = chart.prepareFinancialData([annual(2025, 100, -25), annual(2026, null, 10)], 'annual');
  const option = chart.createChartOption(rows, 'annual');
  assert.deepEqual(option.series.map(series => [series.type, series.yAxisIndex]), [['bar', 0], ['bar', 0], ['line', 1]]);
  assert.equal(option.series[0].stack, undefined);
  assert.deepEqual(option.series[0].data, [100, null]);
  assert.deepEqual(option.series[1].data, [-25, 10]);
  assert.deepEqual(option.series[2].data, [-25, null]);
  assert.equal(option.yAxis[0].scale, false);
  assert.equal(option.tooltip.trigger, 'axis');
});

test('전체 분기는 40개 원본을 보유하되 dataZoom으로 최근 12개를 먼저 보여준다', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ label: `Q${index}`, revenue: index, netIncome: index }));
  const option = chart.createChartOption(rows, 'quarterly', 'all');
  assert.equal(option.series[0].data.length, 40);
  assert.deepEqual(option.dataZoom.map(zoom => zoom.type), ['inside', 'slider']);
  assert.equal(option.dataZoom[0].startValue, 28);
  assert.equal(chart.createChartOption(rows.slice(-12), 'quarterly', '12').dataZoom.length, 0);
});

test('공유 tooltip은 기간·공시일·세 값·YoY/QoQ를 표시하고 HTML 입력을 이스케이프한다', () => {
  const row = { label: 'Q2 FY2027', revenue: 96221000000, netIncome: 59688000000, netMargin: 62.03,
    periodStart: '2026-04-27', fiscalPeriodEnd: '2026-07-26', reportedDate: '<script>bad</script>', revenueYoY: 20 };
  const option = chart.createChartOption([row], 'quarterly');
  const html = option.tooltip.formatter([{ dataIndex: 0 }]);
  for (const text of ['Q2 FY2027', '$96.22B', '$59.69B', '62.03%', '2026-04-27 ~ 2026-07-26', '전분기 대비', '+20.00%', '—']) assert.ok(html.includes(text));
  assert.ok(!html.includes('<script>'));
});

test('금액 K/M/B/T와 퍼센트 포맷은 주가·배당 formatter와 독립적이다', () => {
  assert.equal(chart.formatAmount(1000), '$1K');
  assert.equal(chart.formatAmount(1000000), '$1M');
  assert.equal(chart.formatAmount(130497000000), '$130.50B');
  assert.equal(chart.formatAmount(1e12), '$1T');
  assert.equal(chart.formatAmount(-1e9), '-$1B');
  assert.equal(chart.formatAmount(null), '—');
  assert.equal(chart.formatPercent(62.032196), '62.03%');
});

// 실제 저장·네트워크 없이 컨트롤러 생명주기를 검증한다. DOM mock은 재무 패널만 표현한다.
function controllerFixture(loadLibrary) {
  let onClick;
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { textContent: '', hidden: false, clientWidth: 900,
      setAttribute() {}, classList: { contains: () => false } });
    return elements.get(selector);
  };
  const root = { querySelector: element, querySelectorAll: () => [],
    classList: { contains: () => false }, closest: () => ({ classList: { contains: () => false } }),
    addEventListener(type, listener) { onClick = listener; } };
  const controller = chart.createController(root, { loadLibrary });
  const click = (type, value) => onClick({ target: { closest: selector =>
    selector === `[data-financial-${type}]` ? { dataset: { [type === 'period' ? 'financialPeriod' : 'financialRange']: value } } : null } });
  return { controller, elements, click };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test('연간/분기 toggle은 같은 instance를 갱신하며 ticker 전환·닫기는 dispose한다', async () => {
  const instances = [];
  const library = { init: () => {
    const instance = { options: [], disposed: false, setOption(option) { this.options.push(option); },
      resize() {}, dispose() { this.disposed = true; } };
    instances.push(instance); return instance;
  } };
  const { controller, click } = controllerFixture(async () => library);
  controller.setCompany({ ticker: 'NVDA', financials: [annual(2025, 100), quarter(2027, 'Q2', '2026-07-26', 200)] });
  await settle(); click('period', 'quarterly'); await settle();
  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0].options.at(-1).xAxis.data, ['Q2 FY2027']);
  controller.setCompany({ ticker: 'O', financials: [annual(2025, 300)] }); await settle();
  assert.equal(instances[0].disposed, true);
  assert.deepEqual(instances[1].options.at(-1).series[0].data, [300]);
  controller.dispose(); assert.equal(instances[1].disposed, true);
});

test('로딩 중 닫힌 모달에는 늦은 응답으로 instance를 만들지 않는다', async () => {
  let resolve, initialized = 0;
  const { controller } = controllerFixture(() => new Promise(done => { resolve = done; }));
  controller.setCompany({ ticker: 'NVDA', financials: [annual(2025)] });
  controller.dispose(); resolve({ init: () => { initialized += 1; } }); await settle();
  assert.equal(initialized, 0);
});

test('CDN 실패에서도 요약값을 유지하고 재시도 안내를 표시한다', async () => {
  const { controller, elements } = controllerFixture(async () => { throw new Error('CDN 차단'); });
  controller.setCompany({ ticker: 'NVDA', financials: [annual(2025)] }); await settle();
  assert.equal(elements.get('[data-financial-value="revenue"]').textContent, '$100');
  assert.match(elements.get('[data-financial-status]').textContent, /인터넷 연결/);
  assert.equal(elements.get('[data-financial-retry]').hidden, false);
});
