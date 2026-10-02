import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../financial-chart.js';
import '../reit-financial-chart.js';

const reit = globalThis.ReitFinancialChart;
const record = (year, q = 'FY', value = 100, definition = 'V1') => ({ fiscalYear: year, fiscalPeriod: q,
  periodStart: `${year}-01-01`, periodEnd: `${year}-${q === 'FY' ? '12' : String(Number(q[1]) * 3).padStart(2, '0')}-28`,
  value, unit: 'USD', definitionVersion: definition, definitionOwner: 'ISSUER', attributionBasis: 'common', validationStatus: 'parsed' });
const payload = (metric, data, extra = {}) => ({ ticker: 'SYNREIT', metric, scope: 'annual', basis: 'total',
  shareBasis: 'not_applicable', data, definitionBoundaries: [], ...extra });
const batch = rows => ['FFO', 'NORMALIZED_FFO', 'AFFO'].map(metric => payload(metric, rows));

for (const type of ['GENERAL', 'BANK', 'EXCHANGE', 'UNKNOWN', undefined]) {
  test(`P9B ${type}는 REIT 분기가 아니다`, () => assert.equal(reit.isReit({ ticker: 'O', analysisProfile: { type } }), false));
}
test('P9B synthetic ticker도 REIT profile이면 REIT UI이며 ticker 이름은 사용하지 않는다', () => {
  assert.equal(reit.isReit({ ticker: 'SYNREIT', analysisProfile: { type: 'REIT' } }), true);
  const source = readFileSync(new URL('../reit-financial-chart.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /ticker\s*===?\s*['"]O['"]/);
});
test('P9B 7 selector, total canonical enum, diluted per-share, YTD 미노출', () => {
  assert.equal(Object.keys(reit.configs).length, 7);
  for (const key of ['core', 'ffo', 'nffo', 'affo']) {
    assert.equal(reit.configs[key].basis, 'total'); assert.equal(reit.configs[key].shareBasis, 'not_applicable');
  }
  for (const key of ['ffoShare', 'nffoShare', 'affoShare']) {
    assert.equal(reit.configs[key].basis, 'per_share'); assert.equal(reit.configs[key].shareBasis, 'diluted');
  }
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/data-reit-metric=/g) || []).length, 7);
  assert.doesNotMatch(html, /data-reit-period="ytd"/);
});
test('P9B combo는 동일 금액 축 3 grouped bars이며 저장 0·음수·null을 변경하지 않는다', () => {
  const input = [payload('FFO', [record(2025, 'FY', 0)]), payload('AFFO', [record(2025, 'FY', -12)]), payload('NORMALIZED_FFO', [])];
  const before = JSON.stringify(input), rows = reit.prepareData(input, 'annual');
  const option = reit.createChartOption(rows, 'annual', '12', false, reit.configs.core);
  assert.deepEqual(option.series.map(item => item.data), [[0], [null], [-12]]);
  assert.equal(option.yAxis.length, 1);
  for (const item of option.series) { assert.equal(item.type, 'bar'); assert.equal(item.stack, undefined); assert.equal(item.yAxisIndex, 0); }
  assert.equal(JSON.stringify(input), before);
});
test('P9B Annual/Quarterly 범위는 기존 정책을 재사용하며 NFFO 공시전 gap을 유지한다', () => {
  const records = Array.from({ length: 40 }, (_, i) => record(2016 + Math.floor(i / 4), `Q${i % 4 + 1}`, i));
  const rows = reit.prepareData([payload('FFO', records), payload('AFFO', records), payload('NORMALIZED_FFO', records.slice(-19))], 'quarterly');
  assert.equal(rows.length, 40); assert.equal(rows.filter(row => row.values.NORMALIZED_FFO !== null).length, 19);
  for (const [range, size] of [['8', 8], ['12', 12], ['20', 20], ['all', 40]]) {
    assert.equal(globalThis.FinancialChart.selectRange(rows, 'quarterly', range).length, size);
  }
  assert.equal(globalThis.FinancialChart.selectRange(rows, 'annual').length, 10);
  assert.equal(rows[0].label, 'Q1 FY2016');
});
test('P9B 최신 NFFO 누락은 과거값으로 fallback하지 않는다', () => {
  const rows = reit.prepareData([payload('FFO', [record(2024), record(2025)]), payload('NORMALIZED_FFO', [record(2024)])], 'annual');
  assert.equal(rows.at(-1).values.NORMALIZED_FFO, null);
  assert.equal(reit.formatValue(rows.at(-1).values.NORMALIZED_FFO, 'total'), '—');
});
test('P9B API boundary만 marker가 되고 tooltip도 같은 기간을 사용한다', () => {
  const second = record(2025, 'FY', 105, 'V2');
  const rows = reit.prepareData([payload('AFFO', [record(2024), second], {
    definitionBoundaries: [{ ...second, previousDefinitions: [{ version: 'V1' }], definitions: [{ version: 'V2' }] }]
  })], 'annual');
  const option = reit.createChartOption(rows, 'annual', '12', false, reit.configs.affo, 'SYNREIT');
  assert.deepEqual(option.series[0].markLine.data, [{ xAxis: 1, name: '정의 변경' }]);
  const html = option.tooltip.formatter([{ dataIndex: 1 }]);
  for (const text of ['FY2025', '2025-01-01', '2025-12-28', 'V2', 'parsed', '정의 변경', '— (정의 변경)']) assert.ok(html.includes(text));
});
test('P9B 정의가 바뀌어도 API boundary가 없으면 임의 marker를 만들지 않는다', () => {
  const rows = reit.prepareData([payload('AFFO', [record(2024), record(2025, 'FY', 105, 'V2')])], 'annual');
  assert.equal(reit.createChartOption(rows, 'annual', '12', false, reit.configs.affo).series[0].markLine.data.length, 0);
});
test('P9B 정의·metric·basis·shareBasis·owner·귀속 중 하나라도 다르면 변화율을 차단한다', () => {
  const a = { ...record(2025), metric: 'FFO', basis: 'total', shareBasis: 'not_applicable' };
  for (const key of ['metric', 'basis', 'shareBasis', 'definitionVersion', 'definitionOwner', 'attributionBasis']) {
    assert.equal(reit.change(a, { ...a, [key]: 'OTHER' }).reason, 'definition');
  }
  assert.equal(reit.change({ ...a, value: 120 }, a).value, 20);
  assert.equal(reit.change(a, { ...a, value: 0 }).value, null);
});
test('P9B QoQ/YoY는 FY/FQ로 비교하며 빠진 분기를 건너뛰지 않는다', () => {
  const rows = reit.prepareData(batch([record(2024, 'Q4', 100), record(2025, 'Q1', 120), record(2025, 'Q3', 130)]), 'quarterly');
  assert.equal(rows[1].changes.FFO.qoq.value, 20); assert.equal(rows[2].changes.FFO.qoq.value, null);
});
test('P9B 복수 정의의 동일 기간은 합산·overwrite하지 않고 gap/검토 문구로 표시한다', () => {
  const rows = reit.prepareData([payload('FFO', [record(2025), record(2025, 'FY', 110, 'V2')])], 'annual');
  assert.equal(rows[0].values.FFO, null);
  assert.match(reit.tooltipHtml(rows[0], 'annual', reit.configs.ffo), /복수 정의 저장/);
});
test('P9B per-share formatter·접근성 설명·compact tooltip·dataZoom', () => {
  assert.equal(reit.formatValue(1.2345, 'per_share'), '$1.23'); assert.equal(reit.formatValue(null, 'per_share'), '—');
  const rows = reit.prepareData(batch(Array.from({ length: 20 }, (_, i) => record(2020 + Math.floor(i / 4), `Q${i % 4 + 1}`))), 'quarterly');
  const option = reit.createChartOption(rows, 'quarterly', '20', true, reit.configs.ffoShare, 'SYNREIT');
  assert.equal(option.dataZoom.length, 2); assert.equal(option.tooltip.confine, true);
  assert.equal(option.tooltip.textStyle.fontSize, 10); assert.match(option.aria.label.description, /SYNREIT 분기 FFO\/주 20개 기간/);
});

const fetcher = async url => {
  const parsed = new URL(url), query = Object.fromEntries(parsed.searchParams);
  return { ok: true, json: async () => payload(query.metric, [], { ...query, ticker: parsed.pathname.split('/')[3] }) };
};
test('P9B client는 세 series 병렬 요청을 session cache에서 공유한다', async () => {
  const requests = [];
  const client = reit.createClient({ apiUrl: path => `https://fixture.invalid${path}`, fetcher: (...args) => { requests.push(args); return fetcher(...args); } });
  await Promise.all([client.read('SYNREIT', 'annual', reit.configs.core), client.read('SYNREIT', 'annual', reit.configs.ffo)]);
  assert.equal(requests.length, 3);
  for (const [url] of requests) { assert.match(url, /basis=total/); assert.match(url, /shareBasis=not_applicable/); }
  await client.read('SYNREIT', 'quarterly', reit.configs.affoShare);
  assert.equal(requests.length, 6); assert.match(requests[5][0], /basis=per_share&shareBasis=diluted/);
  client.clear(); assert.equal(requests[0][1].signal.aborted, true);
});
for (const kind of ['HTTP', 'schema', 'ticker', 'scope', 'unit']) {
  test(`P9B ${kind} 실패는 빈 series로 가장하지 않고 오류를 반환한다`, async () => {
    const client = reit.createClient({ apiUrl: path => `https://fixture.invalid${path}`, fetcher: async url => {
      const r = await fetcher(url), data = await r.json();
      if (kind === 'HTTP') return { ok: false };
      if (kind === 'schema') data.data = null;
      if (kind === 'ticker') data.ticker = 'OTHER';
      if (kind === 'scope') data.scope = 'ytd';
      if (kind === 'unit') data.data = [{ ...record(2025), unit: 'USD/share' }];
      return { ok: true, json: async () => data };
    } });
    await assert.rejects(client.read('SYNREIT', 'annual', reit.configs.core)); client.clear();
  });
}

function controllerFixture(client) {
  const elements = new Map(), instances = [];
  let handler;
  const element = key => {
    if (!elements.has(key)) elements.set(key, { textContent: '', hidden: false, innerHTML: '', clientWidth: 900,
      attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
    return elements.get(key);
  };
  const root = { hidden: false, querySelector: element, querySelectorAll: () => [], closest: () => ({ classList: { contains: () => false } }),
    addEventListener(type, callback) { handler = callback; } };
  const controller = reit.createController(root, { client, loadLibrary: async () => ({ init: () => {
    const instance = { setOption(option) { this.option = option; }, dispose() { this.disposed = true; }, resize() {} };
    instances.push(instance); return instance;
  } }) });
  const click = (kind, value) => handler({ target: { closest: selector => selector === `[data-reit-${kind}]`
    ? { dataset: { reitMetric: value, reitPeriod: value, reitRange: value } } : null } });
  return { controller, root, elements, instances, click };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const company = ticker => ({ ticker, analysisProfile: { type: 'REIT' } });
test('P9B O→synthetic REIT 늦은 응답 race와 dispose 후 응답을 차단한다', async () => {
  const pending = new Map();
  const f = controllerFixture({ read: ticker => new Promise(resolve => pending.set(ticker, resolve)), clear() {} });
  f.controller.setCompany(company('O')); f.controller.setCompany(company('SYNREIT'));
  pending.get('SYNREIT')(batch([record(2025, 'FY', 123)])); await settle();
  pending.get('O')(batch([record(2025, 'FY', 456)])); await settle();
  assert.equal(f.instances.length, 1); assert.deepEqual(f.instances[0].option.series[0].data, [123]);
  assert.match(f.elements.get('#detailReitFinancialMetrics').attributes['aria-label'], /SYNREIT/);
  f.controller.show(); f.controller.dispose(); pending.get('SYNREIT')(batch([record(2025)])); await settle();
  assert.equal(f.instances.length, 1);
});
test('P9B controller empty/API error를 구분하며 partial missing을 오류로 취급하지 않는다', async () => {
  let result = [];
  const f = controllerFixture({ read: async () => result, clear() {} });
  f.controller.setCompany(company('SYNREIT')); await settle();
  assert.equal(f.elements.get('[data-reit-status]').textContent, '이 기간에 사용할 수 있는 데이터가 없습니다.');
  result = [payload('FFO', [record(2025)]), payload('NORMALIZED_FFO', []), payload('AFFO', [])];
  f.controller.show(); await settle();
  assert.deepEqual(f.instances.at(-1).option.series[1].data, [null]);
  assert.equal(f.elements.get('[data-reit-status]').hidden, true);
  const failed = controllerFixture({ read: async () => { throw new Error('fixture'); }, clear() {} });
  failed.controller.setCompany(company('SYNREIT')); await settle();
  assert.match(failed.elements.get('[data-reit-status]').textContent, /불러오지 못했습니다/);
  assert.equal(failed.elements.get('[data-reit-retry]').hidden, false);
});
test('P9B profile router는 REIT→GENERAL/BANK 전환에서 기존 차트를 그대로 호출한다', () => {
  const children = { '[data-general-financial]': {}, '[data-reit-financial]': {} }, calls = [];
  const panel = reit.createPanel({ querySelector: key => children[key] }, {
    render: c => calls.push(`general:${c.ticker}`), dispose() {}, prepareTicker: t => calls.push(`prepare:${t}`), show() {}
  }, () => ({ setCompany: c => calls.push(`reit:${c.ticker}`), dispose() {}, show() {} }));
  panel.render(company('SYNREIT')); assert.equal(children['[data-general-financial]'].hidden, true);
  panel.prepareTicker('AAPL'); panel.render({ ticker: 'AAPL', analysisProfile: { type: 'GENERAL' } });
  panel.render({ ticker: 'JPM', analysisProfile: { type: 'BANK' } });
  assert.equal(children['[data-reit-financial]'].hidden, true);
  assert.deepEqual(calls, ['reit:SYNREIT', 'prepare:AAPL', 'general:AAPL', 'general:JPM']);
});
test('P9B 숨겨진 modal에서는 specialized 네트워크 요청이 없다', async () => {
  let calls = 0;
  const f = controllerFixture({ read: async () => { calls++; return []; }, clear() {} });
  f.root.hidden = true; f.controller.setCompany(company('SYNREIT')); await settle(); assert.equal(calls, 0);
});
test('P9B 취소된 client 응답은 같은 key의 새 cache를 삭제하지 않는다', async () => {
  const pending = [];
  let calls = 0;
  const client = reit.createClient({ apiUrl: path => `https://fixture.invalid${path}`, fetcher: url => {
    calls++; return new Promise((resolve, reject) => pending.push({ url, resolve, reject }));
  } });
  const first = client.read('SYNREIT', 'annual', reit.configs.core).catch(() => null);
  client.clear();
  const second = client.read('SYNREIT', 'annual', reit.configs.core);
  pending[0].reject(new Error('취소 fixture')); await first;
  for (const entry of pending.slice(3)) entry.resolve(await fetcher(entry.url));
  await second; await client.read('SYNREIT', 'annual', reit.configs.core);
  assert.equal(calls, 6); client.clear();
});
test('P9B range·metric의 이전 응답은 최신 metric/접근성 설명을 덮지 않는다', async () => {
  const pending = [];
  const f = controllerFixture({ read: () => new Promise(resolve => pending.push(resolve)), clear() {} });
  f.controller.setCompany(company('SYNREIT')); f.click('metric', 'affo');
  pending[1](batch([record(2025)])); await settle();
  pending[0](batch([record(2024)])); await settle();
  assert.equal(f.instances.length, 1); assert.equal(f.instances[0].option.series.length, 1);
  assert.equal(f.elements.get('#reitFinancialTitle').textContent, 'AFFO');
  assert.match(f.elements.get('#detailReitFinancialMetrics').attributes['aria-label'], /AFFO/);
});
test('P9B 명시적인 null 주당 값은 basic 주당값이나 total로 fallback하지 않는다', () => {
  const rows = reit.prepareData([payload('FFO', [record(2025, 'FY', null)], { basis: 'per_share', shareBasis: 'diluted' })], 'annual');
  assert.equal(rows[0].values.FFO, null);
  assert.deepEqual(reit.createChartOption(rows, 'annual', '12', false, reit.configs.ffoShare).series[0].data, [null]);
});
test('P9B 동일 FY/FQ의 상이한 기간은 YoY/QoQ를 계산하지 않는다', () => {
  const rows = reit.prepareData([payload('FFO', [record(2024), record(2025), { ...record(2025), periodStart: '2025-02-01' }])], 'annual');
  assert.equal(rows[1].changes.FFO.yoy.value, null); assert.equal(rows[2].changes.FFO.yoy.value, null);
});
