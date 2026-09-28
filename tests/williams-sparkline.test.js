import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const signalSource = readFileSync(new URL('../williams-signal.js', import.meta.url), 'utf8');

function loadOverviewFunctions() {
  const engineContext = {};
  vm.runInNewContext(signalSource, engineContext);
  const context = {
    window: { WilliamsSignalEngine: engineContext.WilliamsSignalEngine },
    normalizeChartCandles: marketData => (marketData?.candles || []).map(candle => ({
      time: candle.candleDate, high: candle.high, low: candle.low, close: candle.close
    })),
    escapeHtml: value => String(value),
    state: { selectedTicker: null },
    document: { createElement: () => ({ addEventListener() {} }) },
    getStoredWilliams: () => ({ zoneClass: 'hold', status: '중립 구간', value: -50,
      signal: { label: '관찰-상승중', className: 'hold' } }),
    getStoredDividendInfo: () => ({ status: 'unknown', nextDate: '미정', daysLeft: '—',
      statusLabel: '배당락일 미확보', yieldRate: '—', yieldDetail: '배당수익률 미확보' }),
    getStoredPricePresentation: () => ({ price: '$50.00', overviewDetail: '+0.00%', directionClass: 'up',
      isStoredClose: false }),
    loadStockChart() {}, renderWatchlist() {}, renderCompanyOverview() {}, openCompanyDetailModal() {}
  };
  vm.createContext(context);
  const sparklineStart = appSource.indexOf('function createStoredSparkline(');
  const sparklineEnd = appSource.indexOf('\nfunction updateCompanySummary', sparklineStart);
  const listStart = appSource.indexOf('function renderOverviewStockRows(');
  const listEnd = appSource.indexOf('\nfunction getStoredWilliams', listStart);
  assert.ok(sparklineStart >= 0 && sparklineEnd > sparklineStart && listStart >= 0 && listEnd > listStart);
  vm.runInContext(appSource.slice(sparklineStart, sparklineEnd), context);
  vm.runInContext(appSource.slice(listStart, listEnd), context);
  return context;
}

function stockWithReadings(readings) {
  const values = [...Array(13).fill(-50), ...readings];
  return { ticker: 'TEST', name: 'Test', marketData: { candles: values.map((reading, index) => ({
    candleDate: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    high: 100, low: 0, close: reading + 100
  })) } };
}

test('작은 선은 실제 Williams %R을 고정 축에 놓고 -20·-80 점선만 그린다', () => {
  const context = loadOverviewFunctions();
  const svg = context.createStoredSparkline(stockWithReadings([-90, -80, -20, -10]),
    { zoneClass: 'hold', status: '중립 구간' });
  assert.match(svg, /viewBox="0 0 110 35"/);
  assert.match(svg, /class="overview-sparkline-guide overbought" x1="0" x2="110" y1="9\.4" y2="9\.4"/);
  assert.match(svg, /class="overview-sparkline-guide oversold" x1="0" x2="110" y1="25\.6" y2="25\.6"/);
  assert.equal((svg.match(/<line /g) || []).length, 2);
  assert.equal(svg.includes('<text'), false);
  assert.match(svg, /<polyline points="0\.00,28\.30 36\.67,25\.60 73\.33,9\.40 110\.00,6\.70"/);
});

test('배당·주가 투자 목록은 같은 Williams 선을 쓰고 일봉이 부족하면 선을 만들지 않는다', () => {
  const context = loadOverviewFunctions();
  const stock = stockWithReadings([-90, -80, -50]);
  for (const showDividendDetails of [true, false]) {
    const rows = [];
    const container = { innerHTML: '', appendChild(row) { rows.push(row); } };
    context.renderOverviewStockRows(container, [stock], '', showDividendDetails);
    assert.equal(rows.length, 1);
    assert.match(rows[0].innerHTML, /overview-sparkline-guide overbought/);
    assert.match(rows[0].innerHTML, /overview-sparkline-guide oversold/);
  }
  assert.equal(context.createStoredSparkline(stockWithReadings([-90]), { zoneClass: 'buy' }), '');
  context.window.WilliamsSignalEngine = undefined;
  assert.equal(context.createStoredSparkline(stock, { zoneClass: 'hold' }), '');
});
