import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../financial-chart.js';

const chart = globalThis.FinancialChart;
const keys = ['operatingIncome', 'grossMargin', 'operatingMargin'];
const annual = (year, fields = {}) => ({ periodType: 'annual', fiscalYear: year, fiscalPeriod: 'FY',
  fiscalPeriodEnd: `${year}-12-31`, periodStart: `${year}-01-01`, reportedDate: `${year + 1}-02-01`, ...fields });
const quarter = (year, period, end, fields = {}) => ({ periodType: 'quarterly', fiscalYear: year,
  fiscalPeriod: period, fiscalPeriodEnd: end, periodStart: '2026-04-27', reportedDate: '2026-08-26', ...fields });
const optionFor = (rows, mode, metric, range = '12') => chart.createChartOption(rows, mode, range, false, metric);

for (const metric of keys) {
  test(`${metric} 설정은 기존 필드·단위와 단일 bar를 사용한다`, () => {
    const config = chart.financialMetricConfigs[metric];
    assert.equal(config.field, metric);
    assert.equal(config.unit, metric === 'operatingIncome' ? 'currency' : 'percent');
    assert.equal(config.chartType, 'bar');
    assert.equal(Object.isFrozen(config), true);
    const option = optionFor([{ label: 'FY2026', [metric]: 10 }], 'annual', metric);
    assert.equal(option.series.length, 1);
    assert.equal(option.series[0].type, 'bar');
    assert.equal(option.yAxis.length, 1);
    assert.equal(option.yAxis[0].scale, false);
    assert.equal(option.legend.show, false);
    assert.equal(option.tooltip.trigger, 'axis');
  });

  test(`${metric} Annual/Quarterly는 원본 FY/Q로 필터·정렬한다`, () => {
    const input = [quarter(2027, 'Q2', '2026-07-26', { [metric]: 20 }), annual(2026, { [metric]: 10 }),
      quarter(2027, 'Q1', '2026-04-26', { [metric]: 15 })];
    assert.deepEqual(chart.prepareFinancialData(input, 'annual').map(row => row.label), ['FY2026']);
    assert.deepEqual(chart.prepareFinancialData(input, 'quarterly').map(row => row.label), ['Q1 FY2027', 'Q2 FY2027']);
  });

  test(`${metric} 부분 null·실제 0·음수를 원래 기간에 유지한다`, () => {
    const rows = chart.prepareFinancialData([annual(2024, { [metric]: null }), annual(2025, { [metric]: 0 }),
      annual(2026, { [metric]: -25 })], 'annual');
    const option = optionFor(rows, 'annual', metric);
    assert.deepEqual(option.series[0].data, [null, 0, -25]);
    assert.equal(option.xAxis.data.length, 3);
    assert.equal(chart.hasMetricData(rows, metric), true);
    assert.match(option.tooltip.formatter([{ dataIndex: 0 }]), /—/);
    assert.match(option.tooltip.formatter([{ dataIndex: 2 }]), metric === 'operatingIncome' ? /-\$25/ : /-25\.00%/);
    assert.equal(chart.hasMetricData([{ [metric]: null }, { [metric]: undefined }], metric), false);
  });

  for (const [range, count] of [['8', 8], ['12', 12], ['20', 20], ['all', 40]]) {
    test(`${metric} ${range} 범위와 공통 dataZoom은 최근 ${count}개를 사용한다`, () => {
      const input = Array.from({ length: 40 }, (_, index) => ({ label: `Q${index}`, [metric]: index }));
      const selected = chart.selectRange(input, 'quarterly', range);
      const option = optionFor(selected, 'quarterly', metric, range);
      assert.equal(option.series[0].data.length, count);
      assert.equal(option.series[0].data.at(-1), 39);
      assert.equal(option.dataZoom.length, count > 12 ? 2 : 0);
      if (count > 12) assert.equal(option.dataZoom[0].startValue, count - 12);
    });
  }

  test(`${metric} 연간 YoY·분기 QoQ·같은 Q 전년 YoY를 matching한다`, () => {
    const yearly = chart.prepareFinancialData([annual(2024, { [metric]: -100 }), annual(2025, { [metric]: -50 }),
      annual(2027, { [metric]: 100 })], 'annual');
    assert.equal(yearly[1].metricChanges[metric].yoy, 50);
    assert.equal(yearly[2].metricChanges[metric].yoy, null);
    const rows = chart.prepareFinancialData([quarter(2026, 'Q2', '2025-07-26', { [metric]: 50 }),
      quarter(2027, 'Q1', '2026-04-26', { [metric]: 80 }), quarter(2027, 'Q2', '2026-07-26', { [metric]: 100 })], 'quarterly');
    assert.equal(rows[2].metricChanges[metric].qoq, 25);
    assert.equal(rows[2].metricChanges[metric].yoy, 100);
    const html = optionFor(rows, 'quarterly', metric).tooltip.formatter([{ dataIndex: 2 }]);
    for (const text of ['Q2 FY2027', 'QoQ 변화 (%)', '+25.00%', 'YoY 변화 (%)', '+100.00%', '2026-04-27 ~ 2026-07-26', '2026-08-26']) assert.ok(html.includes(text));
    assert.ok(!html.includes('%p'));
  });
}

test('영업이익 금액과 저장 마진의 퍼센트 포맷은 재계산·100배 보정하지 않는다', () => {
  const input = annual(2026, { revenue: 100, operatingIncome: 63734000000,
    grossProfit: 999, grossMargin: 74.97531723844068, operatingMargin: 66.23710000935347 });
  const before = JSON.stringify(input);
  const [row] = chart.prepareFinancialData([input], 'annual');
  assert.equal(chart.formatMetricValue(row.operatingIncome, chart.financialMetricConfigs.operatingIncome), '$63.73B');
  assert.equal(chart.formatMetricValue(row.grossMargin, chart.financialMetricConfigs.grossMargin), '74.98%');
  assert.equal(chart.formatMetricValue(row.operatingMargin, chart.financialMetricConfigs.operatingMargin), '66.24%');
  assert.equal(row.grossMargin, input.grossMargin);
  assert.equal(row.operatingMargin, input.operatingMargin);
  assert.equal(JSON.stringify(input), before);
});

test('마진 변화율은 %p가 아닌 percentage change이며 0·누락·비유한 입력은 계산하지 않는다', () => {
  const rows = chart.prepareFinancialData([annual(2024, { grossMargin: 50, operatingMargin: 0 }),
    annual(2025, { grossMargin: 60, operatingMargin: 10 }), annual(2026, { grossMargin: Infinity })], 'annual');
  assert.equal(rows[1].metricChanges.grossMargin.yoy, 20);
  assert.equal(rows[1].metricChanges.operatingMargin.yoy, null);
  assert.equal(rows[2].grossMargin, null);
  assert.equal(rows[2].metricChanges.grossMargin.yoy, null);
});

test('단일 지표에도 Annual 최근 10개만 표시하고 FY label을 유지한다', () => {
  for (const metric of keys) {
    const rows = chart.prepareFinancialData(Array.from({ length: 12 }, (_, index) => annual(2015 + index, { [metric]: index })), 'annual');
    const option = optionFor(chart.selectRange(rows, 'annual'), 'annual', metric);
    assert.equal(option.xAxis.data.length, 10);
    assert.equal(option.xAxis.data[0], 'FY2017');
    assert.equal(option.xAxis.data.at(-1), 'FY2026');
  }
});

test('Phase 2A 콤보는 값·세 series·두 축·legend·tooltip 결과를 유지한다', () => {
  const rows = chart.prepareFinancialData([quarter(2027, 'Q2', '2026-07-26', { revenue: 96221000000,
    netIncome: 59688000000, operatingIncome: 63734000000, grossMargin: 74.9753, operatingMargin: 66.2371 })], 'quarterly');
  const implicit = optionFor(rows, 'quarterly', 'growth');
  const originalCall = chart.createChartOption(rows, 'quarterly');
  assert.deepEqual(JSON.parse(JSON.stringify(implicit)), JSON.parse(JSON.stringify(originalCall)));
  assert.deepEqual(implicit.series.map(item => item.type), ['bar', 'bar', 'line']);
  assert.equal(implicit.yAxis.length, 2);
  assert.deepEqual(implicit.legend.data, ['매출', '순이익', '순마진']);
  const html = implicit.tooltip.formatter([{ dataIndex: 0 }]);
  for (const text of ['$96.22B', '$59.69B', '62.03%', 'Q2 FY2027']) assert.ok(html.includes(text));
  assert.ok(!html.includes('Operating Margin'));
});

// 재무 패널만 모의한다. 실제 브라우저·API·DB에 접근하지 않고 상태와 instance를 검증한다.
function fixture() {
  let clickHandler;
  const elements = new Map(), buttons = new Map(), instances = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { textContent: '', hidden: false, clientWidth: 900,
      attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
    return elements.get(selector);
  };
  for (const metric of ['growth', ...keys]) buttons.set(metric, { disabled: false, dataset: { financialMetric: metric },
    active: false, attributes: {}, classList: { toggle(name, active) { buttons.get(metric).active = active; } },
    setAttribute(name, value) { this.attributes[name] = value; } });
  const root = { querySelector: element, querySelectorAll: selector => selector === '[data-financial-metric]'
    ? [...buttons.values()] : [], classList: { contains: () => false },
    closest: () => ({ classList: { contains: () => false } }), addEventListener(type, callback) { clickHandler = callback; } };
  const library = { init() {
    const instance = { options: [], disposed: false, setOption(option) { this.options.push(option); }, resize() {}, dispose() { this.disposed = true; } };
    instances.push(instance); return instance;
  } };
  const controller = chart.createController(root, { loadLibrary: async () => library });
  const click = (kind, value, disabled = false) => clickHandler({ target: { closest: selector => selector === `[data-financial-${kind}]`
    ? { disabled, dataset: { financialMetric: value, financialPeriod: value, financialRange: value } } : null } });
  return { controller, elements, buttons, instances, click };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const sampleCompany = ticker => ({ ticker, financials: [annual(2026, { revenue: 100, netIncome: 50,
  operatingIncome: 70, grossMargin: 60, operatingMargin: 70 }), ...Array.from({ length: 40 }, (_, index) => {
  const year = 2017 + Math.floor(index / 4), q = index % 4 + 1;
  return quarter(year, `Q${q}`, `${year}-${String(q * 3).padStart(2, '0')}-25`,
    { revenue: index + 1, netIncome: index / 2, operatingIncome: index, grossMargin: 70, operatingMargin: index });
})] });

test('selector 변경은 같은 instance·분기 mode·20Q를 유지하고 접근성 선택 상태를 갱신한다', async () => {
  const { controller, click, elements, buttons, instances } = fixture();
  controller.setCompany(sampleCompany('NVDA')); await settle();
  click('period', 'quarterly'); await settle(); click('range', '20'); await settle();
  for (const metric of keys) {
    click('metric', metric); await settle();
    const option = instances[0].options.at(-1);
    assert.equal(option.series[0].data.length, 20);
    assert.match(option.xAxis.data.at(-1), /^Q4 FY2026$/);
    assert.equal(buttons.get(metric).attributes['aria-pressed'], 'true');
    assert.equal(buttons.get('growth').attributes['aria-pressed'], 'false');
    assert.equal(elements.get('[data-financial-summary-single]').hidden, false);
  }
  assert.equal(instances.length, 1);
  click('metric', 'growth'); await settle();
  assert.equal(instances[0].options.at(-1).series.length, 3);
  assert.equal(instances[0].options.at(-1).series[0].data.length, 20);
  assert.equal(elements.get('[data-financial-summary-single]').hidden, true);
});

test('종목 교체는 활성 metric을 유지하고 Phase 2A 기본 연간·12Q로 돌아오며 이전 데이터는 dispose한다', async () => {
  const { controller, click, instances, elements } = fixture();
  controller.setCompany(sampleCompany('NVDA')); await settle();
  click('metric', 'operatingMargin'); await settle(); click('period', 'quarterly'); await settle();
  controller.prepareTicker('AAPL'); await settle();
  assert.equal(instances[0].disposed, true);
  const company = sampleCompany('AAPL'); company.financials[0].operatingMargin = 25;
  controller.setCompany(company); await settle();
  assert.deepEqual(instances.at(-1).options.at(-1).series[0].data, [25]);
  assert.equal(elements.get('#financialGrowthTitle').textContent, 'Operating Margin');
  assert.equal(elements.get('[data-financial-value="metric"]').textContent, '25.00%');
  controller.dispose(); assert.equal(instances.at(-1).disposed, true);
});

test('모든 선택값이 null이면 요약 —·empty state로 전환하고 정상 metric 복귀 시 다시 그린다', async () => {
  const { controller, click, instances, elements } = fixture();
  controller.setCompany({ ticker: 'JPM', financials: [annual(2026, { revenue: 100, netIncome: 50 })] }); await settle();
  for (const metric of keys) {
    click('metric', metric); await settle();
    assert.match(elements.get('[data-financial-status]').textContent, /이 기간에 사용할 수 있는 데이터가 없습니다/);
    assert.equal(elements.get('[data-financial-value="metric"]').textContent, '—');
    assert.equal(elements.get('[data-financial-retry]').hidden, true);
  }
  assert.equal(instances[0].disposed, true);
  assert.equal(elements.get('#detailFinancialMetrics').attributes['aria-label'], 'JPM 연간 Operating Margin 1개 기간');
  click('metric', 'growth'); await settle();
  assert.equal(instances.length, 2);
  assert.equal(elements.get('[data-financial-status]').hidden, true);
});

test('비활성·알 수 없는 selector는 interaction을 실행하지 않는다', async () => {
  const { controller, click, instances, elements } = fixture();
  controller.setCompany(sampleCompany('NVDA')); await settle();
  const count = instances[0].options.length;
  click('metric', 'operatingIncome', true); click('metric', 'eps'); await settle();
  assert.equal(instances[0].options.length, count);
  assert.equal(elements.get('#financialGrowthTitle').textContent, '성장·수익성');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const name of ['EPS', 'PEG', 'PER', 'P/S', '잉여현금흐름', 'ROE', 'ROIC']) {
    assert.ok(html.includes(`disabled title="다음 단계에서 제공 예정">${name}</button>`));
  }
});

test('최신 선택 기간의 summary는 null을 과거 값으로 대체하지 않고 Annual/Quarterly 전환을 따른다', async () => {
  const { controller, click, elements, instances } = fixture();
  controller.setCompany({ ticker: 'TEST', financials: [annual(2026, { operatingIncome: 200 }),
    quarter(2027, 'Q1', '2026-04-26', { operatingIncome: 100 }), quarter(2027, 'Q2', '2026-07-26', { operatingIncome: null })] });
  await settle(); click('metric', 'operatingIncome'); await settle();
  assert.equal(elements.get('[data-financial-value="metric"]').textContent, '$200');
  click('period', 'quarterly'); await settle();
  assert.equal(elements.get('[data-financial-value="metric"]').textContent, '—');
  assert.equal(elements.get('[data-financial-latest]').textContent, 'Q2 FY2027');
  assert.deepEqual(instances.at(-1).options.at(-1).series[0].data, [100, null]);
});
