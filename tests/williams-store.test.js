import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { readWilliamsSignals, refreshWilliamsSignal } from '../worker/src/williams-store.js';

function environmentWithCandles(readings) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('CREATE TABLE companies (ticker TEXT PRIMARY KEY)');
  database.exec(`CREATE TABLE price_candles (ticker TEXT, candle_date TEXT,
    high_price REAL, low_price REAL, close_price REAL)`);
  database.prepare('INSERT INTO companies (ticker) VALUES (?)').run('TEST');
  const insert = database.prepare(`INSERT INTO price_candles
    (ticker, candle_date, high_price, low_price, close_price) VALUES (?, ?, ?, ?, ?)`);
  [...Array(13).fill(-50), ...readings].forEach((reading, index) => {
    const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    insert.run('TEST', date, 100, 0, reading + 100);
  });

  // 실제 D1과 같은 prepare/bind/run/all 형태로 메모리 SQLite를 연결한다.
  const environment = { DB: {
    prepare(sql) {
      const statement = database.prepare(sql);
      let params = [];
      return {
        bind(...values) { params = values; return this; },
        async run() { statement.run(...params); return { success: true }; },
        async all() { return { results: statement.all(...params) }; }
      };
    }
  } };
  return { database, environment };
}

test('과매수 구간의 유지 상태를 D1에 저장하고 다시 읽는다', async () => {
  const { database, environment } = environmentWithCandles([-10, ...Array(130).fill(-10)]);
  try {
    const calculated = await refreshWilliamsSignal(environment, 'TEST');
    assert.equal(calculated.signal.label, '매도 신호 유지');
    const stored = await readWilliamsSignals(environment, ['TEST']);
    assert.equal(stored.get('TEST').signal.label, '매도 신호 유지');
    assert.equal(stored.get('TEST').lastCandleDate, calculated.lastCandleDate);
  } finally {
    database.close();
  }
});
