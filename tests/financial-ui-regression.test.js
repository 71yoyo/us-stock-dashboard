import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// 기존 함수 자체를 실행하되 DOM·저장소·네트워크는 격리해 사용자 데이터에 접근하지 않는다.
const excerpt = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function fixture() {
  const elements = new Map(), storage = new Map(), alerts = [];
  let exported;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; } });
    return elements.get(id);
  };
  const context = vm.createContext({
    state: { watchlist: [{ ticker: 'NVDA', marketData: {} }, { ticker: 'O' }], holdings: [], selectedTicker: 'NVDA' },
    document: { getElementById: element, querySelectorAll: () => [], createElement: () => ({ click() {} }) },
    localStorage: { setItem: (key, value) => storage.set(key, value) },
    uploadWatchlistToCloudflare() {}, renderWatchlist() {}, renderPortfolio() {}, closeModal() {},
    showDashboardView() {}, addNewStock() {}, renderCompanyOverview() {}, loadStockChart() {},
    confirm: () => true, alert: text => alerts.push(text), Blob,
    URL: { createObjectURL(blob) { exported = blob; return 'blob:test-only'; }, revokeObjectURL() {} },
    FileReader: class { readAsText(file) { this.onload({ target: { result: file.content } }); } }
  });
  vm.runInContext([
    excerpt('function deleteStock(', '/**\n * [서브메뉴 1-3]'),
    excerpt('function reorderWatchlist(', '// 드래그 중인 인덱스'),
    excerpt('function saveHoldings(', '/** 저장된 금융 숫자'),
    excerpt('function setupModals(', 'function openModal(')
  ].join('\n'), context);
  context.setupModals();
  return { context, element, storage, alerts, getExported: () => exported };
}

test('기존 관심목록 순서 변경·삭제와 저장 형식을 유지한다', () => {
  const { context, storage } = fixture();
  context.reorderWatchlist(0, 1);
  assert.deepEqual(JSON.parse(storage.get('stock_app_watchlist')).map(row => row.ticker), ['O', 'NVDA']);
  context.deleteStock('O');
  assert.deepEqual(JSON.parse(storage.get('stock_app_watchlist')), [{ ticker: 'NVDA' }]);
});

test('기존 포트폴리오 입력·저장·재로딩 데이터 형식을 유지한다', () => {
  const { element, storage } = fixture();
  element('holdingTickerInput').value = ' nvda ';
  element('holdingQtyInput').value = '2';
  element('holdingBuyPriceInput').value = '100';
  element('confirmAddHoldingBtn').listeners.click();
  const restored = JSON.parse(storage.get('stock_app_holdings'));
  assert.equal(restored[0].ticker, 'NVDA');
  assert.equal(restored[0].qty, 2);
  assert.equal(restored[0].buyPrice, 100);
  assert.equal(typeof restored[0].id, 'string');
});

test('기존 JSON 백업과 복원 이벤트가 동일 형식으로 왕복한다', async () => {
  const { context, element, storage, alerts, getExported } = fixture();
  element('exportDataBtn').listeners.click();
  const backup = JSON.parse(await getExported().text());
  assert.deepEqual(Object.keys(backup).sort(), ['exportDate', 'holdings', 'watchlist']);
  context.state.watchlist = []; context.state.holdings = [];
  element('importDataInput').listeners.change({ target: { files: [{ content: JSON.stringify(backup) }] } });
  assert.deepEqual(JSON.parse(storage.get('stock_app_watchlist')).map(row => row.ticker), ['NVDA', 'O']);
  assert.deepEqual(JSON.parse(storage.get('stock_app_holdings')), []);
  assert.match(alerts.at(-1), /성공적으로 복원/);
  assert.equal(storage.has('stock_app_pin'), false);
});
