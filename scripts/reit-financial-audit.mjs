import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import '../financial-chart.js';
import '../reit-financial-chart.js';

// 운영 데이터는 공개 GET만 읽고 UI의 순수 준비값/정의 경계를 비교한다. DB 쓰기 경로는 없다.
const base = 'https://us-stock-dashboard-api.771yoyo.workers.dev', results = [];
for (const scope of ['quarterly', 'annual']) for (const basis of ['total', 'per_share']) {
  const shareBasis = basis === 'total' ? 'not_applicable' : 'diluted';
  const payloads = await Promise.all(['FFO', 'NORMALIZED_FFO', 'AFFO'].map(async metric => {
    const query = new URLSearchParams({ metric, scope, basis, shareBasis });
    const res = await fetch(`${base}/api/companies/O/specialized-metrics?${query}`);
    assert.equal(res.status, 200);
    const json = await res.json(); assert.equal(json.analysisProfile.type, 'REIT'); return json;
  }));
  const rows = globalThis.ReitFinancialChart.prepareData(payloads, scope);
  for (const payload of payloads) {
    assert.equal(payload.data.length, scope === 'quarterly' ? (payload.metric === 'NORMALIZED_FFO' ? 19 : 40)
      : (payload.metric === 'NORMALIZED_FFO' ? 5 : 10));
    for (const record of payload.data) {
      const row = rows.find(item => item.key === globalThis.ReitFinancialChart.periodKey(record));
      assert.equal(row.values[payload.metric], record.value);
    }
    const boundaryKeys = payload.definitionBoundaries.map(globalThis.ReitFinancialChart.periodKey);
    assert.deepEqual(rows.flatMap(row => row.boundaries.filter(b => b.metric === payload.metric)
      .map(globalThis.ReitFinancialChart.periodKey)), boundaryKeys);
    const config = { label: payload.metric, metrics: [payload.metric], basis, shareBasis };
    const option = globalThis.ReitFinancialChart.createChartOption(rows, scope, 'all', false, config, 'O');
    assert.equal(option.series[0].markLine.data.length, boundaryKeys.length);
    for (const key of boundaryKeys) assert.match(globalThis.ReitFinancialChart.tooltipHtml(rows.find(row => row.key === key), scope, config), /정의 변경/);
    results.push({ scope, basis, metric: payload.metric, count: payload.data.length, exactValues: true,
      boundaries: payload.definitionBoundaries.map(b => `${b.fiscalPeriod} FY${b.fiscalYear}`), boundaryExact: true });
  }
}
// checkpoint의 GENERAL 순수 계산/tooltip/option을 실제 저장값으로 deep equality 비교한다.
const oldSource = execFileSync('git', ['show', '9c524367c404338e097dd5a5e2f7975f44f9fd70:financial-chart.js'], { encoding: 'utf8' });
const old = vm.createContext({}); vm.runInContext(oldSource, old);
for (const ticker of ['NVDA', 'AAPL', 'MSFT', 'TSLA', 'JPM']) {
  const response = await fetch(`${base}/api/companies/${ticker}`); assert.equal(response.status, 200);
  const { company } = await response.json();
  for (const scope of ['annual', 'quarterly']) for (const metric of ['growth', 'operatingIncome', 'grossMargin', 'operatingMargin']) {
    const a = old.FinancialChart.prepareFinancialData(company.financials, scope);
    const b = globalThis.FinancialChart.prepareFinancialData(company.financials, scope);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    for (const range of ['8', '12', '20', 'all']) {
      const oldRows = old.FinancialChart.selectRange(a, scope, range), newRows = globalThis.FinancialChart.selectRange(b, scope, range);
      assert.equal(JSON.stringify(old.FinancialChart.createChartOption(oldRows, scope, range, false, metric)),
        JSON.stringify(globalThis.FinancialChart.createChartOption(newRows, scope, range, false, metric)));
      for (const row of b) assert.equal(old.FinancialChart.tooltipHtml(row, scope, metric), globalThis.FinancialChart.tooltipHtml(row, scope, metric));
    }
  }
  results.push({ ticker, generalNumericOptionTooltipRegression: 'PASS', profile: company.analysisProfile.type });
}
assert.match(readFileSync('reit-financial-chart.js', 'utf8'), /company\?\.analysisProfile\?\.type === 'REIT'/);
mkdirSync('backups/p9b', { recursive: true });
writeFileSync('backups/p9b/read-only-audit.json', JSON.stringify({ timestamp: new Date().toISOString(), results, productionWrite: 0 }, null, 2));
console.log(JSON.stringify({ status: 'PASS', results, productionWrite: 0 }));
