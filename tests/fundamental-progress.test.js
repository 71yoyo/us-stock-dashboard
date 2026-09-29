import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../fundamental-progress.js', import.meta.url), 'utf8');

// 페이지 초기화 없이 5-3의 배당 상태 표시만 격리해 이전 SEC 작업값 노출을 확인한다.
function statusFunctions() {
  const start = source.indexOf('function dividendStorageStatus(');
  const end = source.indexOf('function createMarketCell(', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    document: { createElement: tag => ({ tag, children: [], appendChild(child) { this.children.push(child); } }) },
    createStatusBadge: status => ({ status }),
    appendDetail: (cell, value) => cell.children.push({ text: String(value) })
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test('SEC 배당 오류와 연간·분기 건수는 5-3 배당 열에 노출하지 않는다', () => {
  const context = statusFunctions();
  const job = { kind: 'dividends', status: 'error', error: 'SEC EDGAR HTTP 403',
    details: { source: 'SEC EDGAR', annualCount: 7, quarterlyCount: 25 } };
  const cell = context.createJobCell(job, { source: 'BUSINESS_QUANT', status: 'ready', count: 92 });
  assert.equal(cell.children[0].status, 'ready');
  const text = cell.children.map(child => child.text || '').join(' ');
  assert.match(text, /Business Quant 배당 이력 92개/);
  assert.doesNotMatch(text, /SEC|연간 7개|분기 25개/);
});

test('BQ 응답이 비어 있으면 무배당 완료로 단정하지 않는다', () => {
  const context = statusFunctions();
  const job = { kind: 'dividends', status: 'ready', details: { source: 'BUSINESS_QUANT' } };
  const cell = context.createJobCell(job, { source: 'BUSINESS_QUANT', status: 'pending', count: 0 });
  assert.equal(cell.children[0].status, 'pending');
  assert.match(cell.children[1].text, /0개/);
});

test('BQ 배당 또는 저장 가격이 바뀔 때만 화면을 갱신하고 실패하면 재시도한다', async () => {
  const createElement = () => ({ children: [], dataset: {}, classList: { contains: () => false },
    appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
    addEventListener() {} });
  const elements = Object.fromEntries(['fundamentalMessage', 'fundamentalRunBtn', 'fundamentalSummary',
    'fundamentalProgress', 'fundamentalRows', 'fundamentalRefreshBtn'].map(id => [id, createElement()]));
  let storedAt = '2026-09-28T01:00:00Z';
  let priceAt = '2026-09-28T01:00:00Z';
  let refreshCalls = 0;
  let failOnce = false;
  const context = {
    document: { hidden: false, getElementById: id => elements[id], createElement },
    window: {}, state: { apiPin: 'test-pin' }, mainApp: { classList: { contains: () => false } },
    getCloudflareApiUrl: path => `https://example.test${path}`,
    getCloudflareRequestOptions: () => ({}),
    fetch: async () => ({ ok: true, json: async () => ({ summary: {}, stocks: [{ ticker: 'O',
      price: { updatedAt: priceAt },
      candles: { status: 'ready', count: 68 },
      jobs: { dividends: { kind: 'dividends', status: 'ready', details: { source: 'BUSINESS_QUANT' } } },
      dividendEvents: { source: 'BUSINESS_QUANT', status: 'ready', count: 92, updatedAt: storedAt }
    }] }) }),
    refreshStoredDashboardViews: async () => {
      refreshCalls += 1;
      if (failOnce) { failOnce = false; throw new Error('temporary'); }
    },
    console: { warn() {} }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await context.window.FundamentalProgress.refresh();
  assert.equal(refreshCalls, 0, '첫 상태 확인은 최초 로딩의 기준 시각만 기록한다');
  storedAt = '2026-09-28T02:00:00Z';
  await context.window.FundamentalProgress.refresh();
  assert.equal(refreshCalls, 1);
  await context.window.FundamentalProgress.refresh();
  assert.equal(refreshCalls, 1, '동일한 저장본을 반복 조회하지 않는다');
  priceAt = '2026-09-28T02:30:00Z';
  await context.window.FundamentalProgress.refresh();
  assert.equal(refreshCalls, 2, '수익률 분모인 저장 가격이 바뀌어도 다시 읽는다');
  storedAt = '2026-09-28T03:00:00Z';
  failOnce = true;
  await context.window.FundamentalProgress.refresh();
  await context.window.FundamentalProgress.refresh();
  assert.equal(refreshCalls, 4, '화면 갱신 실패는 다음 상태 확인에서 재시도한다');
});

test('배당 저장 전에도 새 일봉 날짜가 오면 열린 종합 화면을 다시 읽는다', async () => {
  const createElement = () => ({ children: [], dataset: {}, classList: { contains: () => false },
    appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
    addEventListener() {} });
  const elements = Object.fromEntries(['fundamentalMessage', 'fundamentalRunBtn', 'fundamentalSummary',
    'fundamentalProgress', 'fundamentalRows', 'fundamentalRefreshBtn'].map(id => [id, createElement()]));
  let latestDate = '2026-09-25';
  let refreshCalls = 0;
  const context = {
    document: { hidden: false, getElementById: id => elements[id], createElement },
    window: {}, state: { apiPin: 'test-pin' }, mainApp: { classList: { contains: () => false } },
    getCloudflareApiUrl: path => `https://example.test${path}`,
    getCloudflareRequestOptions: () => ({}),
    fetch: async () => ({ ok: true, json: async () => ({ summary: {}, stocks: [{ ticker: 'O',
      price: { updatedAt: null }, candles: { status: 'ready', count: 72, latestDate,
        updatedAt: '2026-09-28 06:15:00' },
      jobs: { dividends: { kind: 'dividends', status: 'pending' } },
      dividendEvents: { status: 'pending', count: 0 }
    }] }) }),
    refreshStoredDashboardViews: async () => { refreshCalls += 1; },
    console: { warn() {} }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await context.window.FundamentalProgress.refresh();
  assert.equal(refreshCalls, 0);
  latestDate = '2026-09-28';
  await context.window.FundamentalProgress.refresh();
  assert.equal(refreshCalls, 1);
  await context.window.FundamentalProgress.refresh();
  assert.equal(refreshCalls, 1);
  const dateDetails = elements.fundamentalRows.children[0].children[1].children
    .map(child => child.textContent || '').join(' ');
  assert.match(dateDetails, /최신 일봉 2026-09-28/);
  assert.match(dateDetails, /저장 확인/);
});
