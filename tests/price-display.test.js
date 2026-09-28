import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function functionSource(name, nextMarker) {
  const start = appSource.indexOf(`function ${name}(`);
  const end = appSource.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `${name} 함수 위치를 찾을 수 없습니다.`);
  return appSource.slice(start, end);
}

test('현재가가 없으면 직전 저장 거래일 대비 등락률을 표시하고 현재가 상태는 비워 둔다', () => {
  // PIN과 네트워크 초기화를 실행하지 않고 표시·상태 변경 함수만 검증한다.
  const context = {
    toNullableNumber: value => value == null ? null : Number(value),
    normalizeChartCandles: company => company?.candles || [],
    formatCurrency: value => value == null ? '데이터 없음' : `$${Number(value).toFixed(2)}`,
    formatPercent: value => value == null ? '—' : `${value >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`,
    formatPriceChange: () => '기존 등락률',
    getChangeDirectionClass: value => value == null ? 'unknown' : value >= 0 ? 'up' : 'down',
    formatMonthDay: value => `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`
  };
  vm.createContext(context);
  vm.runInContext(functionSource('applyStoredCompanyToStock', '\nfunction setStoredDataConnectionState'), context);
  vm.runInContext(functionSource('getStoredPricePresentation', '\n/** 저장된 신호'), context);

  const stock = { ticker: 'O', price: 99, change: 1, changePct: 1 };
  context.applyStoredCompanyToStock(stock, { ticker: 'O', currentPrice: null, changePercent: null,
    candles: [{ time: '2026-09-24', close: 55.41 }, { time: '2026-09-25', close: 55.54 }] });
  assert.equal(stock.price, null);
  assert.equal(stock.changePct, null);
  const fallback = context.getStoredPricePresentation(stock);
  assert.equal(fallback.price, '$55.54');
  assert.equal(fallback.overviewDetail, '+0.23%');
  assert.equal(fallback.overviewSource, '9/25 종가 기준');
  assert.equal(fallback.sourceLabel, '2026-09-25 저장 일봉 종가');
  assert.equal(fallback.isStoredClose, true);
  assert.equal(fallback.directionClass, 'up');

  context.applyStoredCompanyToStock(stock, { ticker: 'ABT', currentPrice: null,
    candles: [{ time: '2026-09-24', close: 102 }, { time: '2026-09-25', close: 101.29 }] });
  const falling = context.getStoredPricePresentation(stock);
  assert.equal(falling.overviewDetail, '-0.70%');
  assert.equal(falling.directionClass, 'down');

  context.applyStoredCompanyToStock(stock, { ticker: 'O', currentPrice: null,
    candles: [{ time: '2026-09-25', close: 55.54 }] });
  const insufficient = context.getStoredPricePresentation(stock);
  assert.equal(insufficient.overviewDetail, '2026-09-25 저장 일봉 종가');
  assert.equal(insufficient.directionClass, 'unknown');

  context.applyStoredCompanyToStock(stock, { ticker: 'O', currentPrice: 56, changePercent: 0.5,
    candles: [{ time: '2026-09-25', close: 55.54 }] });
  const quoted = context.getStoredPricePresentation(stock);
  assert.equal(quoted.price, '$56.00');
  assert.equal(quoted.overviewDetail, '+0.50%');
  assert.equal(quoted.isStoredClose, false);

  stock.price = null;
  stock.marketData = { candles: [] };
  assert.equal(context.getStoredPricePresentation(stock).price, '데이터 없음');
});

test('종합 종목 행은 저장 종가의 등락률과 기준일을 함께 출력한다', () => {
  const context = {
    state: { selectedTicker: 'O' },
    document: { createElement: () => ({ addEventListener() {} }) },
    getStoredWilliams: () => null,
    getStoredDividendInfo: () => ({}),
    getStoredPricePresentation: () => ({ price: '$55.54', overviewDetail: '+0.23%',
      overviewSource: '9/25 종가 기준', sourceLabel: '2026-09-25 저장 일봉 종가',
      directionClass: 'up', isStoredClose: true }),
    createStoredSparkline: () => '',
    escapeHtml: value => String(value),
    formatMonthDay: value => value,
    loadStockChart() {}, renderWatchlist() {}, renderCompanyOverview() {}, openCompanyDetailModal() {}
  };
  vm.createContext(context);
  vm.runInContext(functionSource('renderOverviewStockRows', '\nfunction getStoredWilliams'), context);
  const rows = [];
  const container = { innerHTML: '', appendChild(row) { rows.push(row); } };
  context.renderOverviewStockRows(container, [{ ticker: 'O', name: 'Realty Income' }], '', false);
  assert.equal(rows.length, 1);
  assert.match(rows[0].innerHTML, /\$55\.54[\s\S]*\+0\.23%[\s\S]*9\/25 종가 기준/);
});
