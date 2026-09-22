import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadTradingViewModule() {
  const source = readFileSync(new URL('../tradingview-widget.js', import.meta.url), 'utf8');
  const context = { window: {} };
  vm.runInNewContext(source, context);
  return context.window.TradingViewCharts;
}

test('FMP 거래소 표기를 TradingView 심볼로 안전하게 변환', () => {
  const charts = loadTradingViewModule();

  assert.equal(charts.buildSymbol('nvda', 'Nasdaq Global Select'), 'NASDAQ:NVDA');
  assert.equal(charts.buildSymbol('O', 'New York Stock Exchange'), 'NYSE:O');
  assert.equal(charts.buildSymbol('SPY', 'NYSE Arca'), 'AMEX:SPY');
  assert.equal(charts.buildSymbol('brk.b', ''), 'BRK.B');
  assert.equal(charts.buildSymbol('AAPL<script>', 'NASDAQ'), 'NASDAQ:AAPLSCRIPT');
});

test('기본 위젯은 3개월 일봉·MA20·Williams %R로 구성', () => {
  const charts = loadTradingViewModule();
  const options = charts.buildOptions({ ticker: 'AAPL', exchange: 'NASDAQ' });

  assert.equal(options.symbol, 'NASDAQ:AAPL');
  assert.equal(options.interval, 'D');
  assert.equal(options.range, '3M');
  assert.equal(options.hide_volume, false);
  assert.deepEqual(Array.from(options.studies), [
    'MASimple@tv-basicstudies',
    'WilliamsR@tv-basicstudies'
  ]);
  assert.equal(options.studies_overrides['moving average.length'], 20);
});
