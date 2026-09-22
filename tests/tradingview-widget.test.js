import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadTradingViewModule() {
  const source = readFileSync(new URL('../tradingview-widget.js', import.meta.url), 'utf8');
  const context = { window: {}, URL };
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

test('기본 위젯은 일봉·MA20·Williams %R로 구성', () => {
  const charts = loadTradingViewModule();
  const options = charts.buildOptions({ ticker: 'AAPL', exchange: 'NASDAQ' });

  assert.equal(options.symbol, 'NASDAQ:AAPL');
  assert.equal(options.interval, 'D');
  assert.equal('range' in options, false);
  assert.equal(options.hide_volume, false);
  assert.equal(options.hide_top_toolbar, true);
  assert.equal(options.theme, 'dark');
  assert.equal(options.backgroundColor, 'rgba(17, 26, 34, 1)');
  assert.deepEqual(Array.from(options.studies), [
    'MASimple@tv-basicstudies',
    'WilliamsR@tv-basicstudies'
  ]);
  assert.equal(options.studies_overrides['moving average.length'], 20);
});

test('차트 버튼은 이름과 같은 실제 캔들 단위로 변환한다', () => {
  const charts = loadTradingViewModule();
  assert.deepEqual(
    { ...charts.resolveForInterval('1') },
    { interval: '1' }
  );
  assert.deepEqual(
    { ...charts.resolveForInterval('5') },
    { interval: '5' }
  );
  assert.deepEqual(
    { ...charts.resolveForInterval('15') },
    { interval: '15' }
  );
  assert.deepEqual(
    { ...charts.resolveForInterval('60') },
    { interval: '60' }
  );
  assert.deepEqual(
    { ...charts.resolveForInterval('D') },
    { interval: 'D' }
  );
  assert.deepEqual(
    { ...charts.resolveForInterval('W') },
    { interval: 'W' }
  );
  assert.deepEqual(
    { ...charts.resolveForInterval('M') },
    { interval: 'M' }
  );
  assert.deepEqual(
    { ...charts.normalizeSettings({ interval: '잘못된값' }) },
    { interval: 'D' }
  );
});

test('위젯 주소는 브라우저 저장값보다 다크 테마를 우선하도록 명시한다', () => {
  const charts = loadTradingViewModule();
  const widgetUrl = new URL(charts.buildUrl(
    { ticker: 'NVDA', exchange: 'NASDAQ' },
    { interval: 'D' },
    'tv-nvda-D'
  ));
  const settings = JSON.parse(decodeURIComponent(widgetUrl.hash.slice(1)));

  assert.equal(widgetUrl.searchParams.get('theme'), 'dark');
  assert.equal(widgetUrl.searchParams.get('backgroundColor'), 'rgba(17, 26, 34, 1)');
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.frameElementId, 'tv-nvda-D');
  assert.equal(charts.usesCredentialless, true);
});
