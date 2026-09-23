import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadEngine() {
  const source = readFileSync(new URL('../williams-signal.js', import.meta.url), 'utf8');
  const context = {};
  vm.runInNewContext(source, context);
  return context.WilliamsSignalEngine;
}

function candlesForReadings(readings) {
  // 최고·최저가가 고정되면 종가 5달러는 -95, 22달러는 -78에 대응한다.
  const prices = [...Array(13).fill(-50), ...readings];
  return prices.map((reading, index) => ({
    time: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    high: 100,
    low: 0,
    close: reading + 100
  }));
}

test('과매도 반등은 검토, -80 상향 돌파는 당일 신호, 이후 중립은 관찰 방향을 표시한다', () => {
  const engine = loadEngine();
  const review = engine.summarize(candlesForReadings([-95, -90]));
  assert.equal(review.signal.label, '매수 검토');
  assert.equal(review.zoneClass, 'buy');

  const confirmed = engine.summarize(candlesForReadings([-95, -90, -78]));
  assert.equal(confirmed.signal.label, '매수 신호');
  assert.equal(confirmed.zoneClass, 'hold');
  assert.equal(confirmed.signal.since, '2026-01-16');

  const later = engine.summarize(candlesForReadings([-95, -90, -78, -60]));
  assert.equal(later.signal.label, '관찰-상승중');
  assert.equal(later.signal.since, null);
});

test('과매수 유지와 반전 검토, -20 하향 터치의 매도 신호를 구분한다', () => {
  const engine = loadEngine();
  const maintained = engine.summarize(candlesForReadings([-15, -10]));
  assert.equal(maintained.signal.label, '매도 신호 유지');
  const watch = engine.summarize(candlesForReadings([-10, -14]));
  assert.equal(watch.signal.label, '매도 검토');

  const crossed = engine.summarize(candlesForReadings([-10, -14, -20]));
  assert.equal(crossed.signal.label, '매도 신호');
  assert.equal(crossed.signal.since, '2026-01-16');
  const neutral = engine.summarize(candlesForReadings([-10, -14, -20, -30]));
  assert.equal(neutral.signal.label, '관찰-하락중');
});

test('종가가 반대로 움직인 기준선 돌파는 확인을 기다리고, 재진입하면 현재 구간을 표시한다', () => {
  const engine = loadEngine();
  const bars = candlesForReadings([-95]);
  bars.push({ time: '2026-01-15', high: 100, low: -30, close: 4 });
  const pending = engine.summarize(bars);
  assert.equal(pending.signal.label, '매수 종가 확인 대기');

  const invalidated = engine.summarize(candlesForReadings([-95, -78, -83]));
  assert.equal(invalidated.signal.label, '매수 신호 유지');
  const touchedAndFailed = engine.summarize(candlesForReadings([-95, -80, -81]));
  assert.equal(touchedAndFailed.signal.label, '매수 신호 유지');
});
