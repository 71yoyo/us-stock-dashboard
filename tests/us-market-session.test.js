import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { completedUsSessionDate, isUsSessionCompleteToday } from '../worker/src/us-market-session.js';

test('서머타임에는 미국 장 종료 30분 전·후를 구분하고 밤새 같은 거래일을 확인한다', () => {
  assert.equal(completedUsSessionDate(new Date('2026-09-28T20:25:00Z')), null);
  assert.equal(completedUsSessionDate(new Date('2026-09-28T20:30:00Z')), '2026-09-28');
  assert.equal(isUsSessionCompleteToday(new Date('2026-09-28T20:30:00Z')), true);
  assert.equal(completedUsSessionDate(new Date('2026-09-29T05:00:00Z')), '2026-09-28');
});

test('겨울에는 미국 장 종료 시각이 한 시간 늦어도 전 거래일을 잘못 완료 처리하지 않는다', () => {
  assert.equal(completedUsSessionDate(new Date('2026-12-28T21:25:00Z')), null);
  assert.equal(completedUsSessionDate(new Date('2026-12-28T21:30:00Z')), '2026-12-28');
  assert.equal(isUsSessionCompleteToday(new Date('2026-12-28T21:25:00Z')), false);
  assert.equal(completedUsSessionDate(new Date('2026-12-29T06:00:00Z')), '2026-12-28');
});

test('금요일 밤과 토요일 새벽은 같은 금요일 일봉을 가리킨다', () => {
  assert.equal(completedUsSessionDate(new Date('2026-09-25T22:10:00Z')), '2026-09-25');
  assert.equal(completedUsSessionDate(new Date('2026-09-26T06:00:00Z')), '2026-09-25');
  const config = JSON.parse(readFileSync(new URL('../worker/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(config.triggers.crons.includes('*/5 21-23 * * 1-5'));
});
