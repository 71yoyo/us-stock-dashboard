// ========================================================
// US Stock Pro - 대시보드 코어 로직 & 차트 엔드포인트
// ========================================================

// 1. 상태(State) 관리
// 과거 화면에 남아 있던 고정 예시 시세는 D1 값이 도착하기 전에도 표시하지 않는다.
const legacyDemoQuotes = Object.freeze({ NVDA: 124.58, AAPL: 228.20, TSLA: 243.90, MSFT: 432.10, AMZN: 186.40 });

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readLocalArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    // 손상된 브라우저 저장값은 금융 데이터를 만들어 내지 않고 빈 목록으로 안전하게 시작한다.
    return [];
  }
}

function normalizeLocalStock(rawStock) {
  const stock = { ...rawStock };
  const legacyPrice = legacyDemoQuotes[stock.ticker];
  // 초기 샘플과 정확히 일치하는 값만 제거해, 사용자가 입력한 실제 값은 건드리지 않는다.
  if (legacyPrice !== undefined && Number(stock.price) === legacyPrice) {
    stock.price = null;
    stock.change = null;
    stock.changePct = null;
  } else {
    stock.price = toNullableNumber(stock.price);
    stock.change = toNullableNumber(stock.change);
    stock.changePct = toNullableNumber(stock.changePct);
  }
  return stock;
}

const state = {
  currentPin: (localStorage.getItem('stock_app_pin') === '1234' ? '5260' : (localStorage.getItem('stock_app_pin') || '5260')),
  enteredPin: '',
  // 환율 API가 아직 연결되지 않았으므로 임의 환산값을 사용하지 않는다.
  usdKrwRate: null,
  isKrwView: false,
  selectedTicker: null,
  // 버튼명과 실제 캔들 단위를 일치시킨다. iframe 내부 UI를 앱 CSS로 바꿀 수 없으므로
  // 선택한 버튼(chartPreset)과 위젯 설정(chartSettings)을 함께 보관해야 활성 표시가 어긋나지 않는다.
  chartPreset: 'D',
  chartSettings: { interval: 'D' },
  dashboardEventsBound: false,
  // Worker 인증이 성공한 현재 PIN만 메모리에 보관한다. 새로고침 뒤에는 다시 PIN을 입력해야 한다.
  apiPin: '',
  watchlistSyncStarted: false,
  
  // 관심종목은 D1 동기화가 기준이며, 로컬에는 오프라인용 목록 설정만 남긴다.
  watchlist: readLocalArray('stock_app_watchlist').map(normalizeLocalStock),

  // 보유 수량과 매수 단가는 예시를 만들지 않는다. 사용자가 직접 저장한 값만 사용한다.
  holdings: readLocalArray('stock_app_holdings')
};

/**
 * Cloudflare Worker 주소는 배포 환경마다 달라질 수 있어 별도 설정 파일에서 읽는다.
 * 주소가 비어 있거나 Worker가 아직 준비되지 않은 경우에도 기존 로컬 화면은 멈추지 않는다.
 */
function getCloudflareApiUrl(path) {
  const configuredBaseUrl = window.US_STOCK_PRO_CONFIG?.apiBaseUrl?.replace(/\/$/, '') || '';
  return configuredBaseUrl ? `${configuredBaseUrl}${path}` : '';
}

function getCloudflareRequestOptions(options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.apiPin) headers.set('X-App-Pin', state.apiPin);
  return { ...options, headers };
}

/**
 * Worker PIN이 설정된 경우에는 서버가 PIN을 최종 검증한다.
 * 아직 Worker PIN을 설정하지 않은 개발 단계에서는 null을 반환하여 기존 로컬 잠금 흐름을 유지한다.
 */
async function verifyPinWithCloudflare(pin) {
  const apiUrl = getCloudflareApiUrl('/api/auth/verify');
  if (!apiUrl) return null;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'X-App-Pin': pin }
    });
    if (response.status === 503) return null;
    return response.ok;
  } catch (error) {
    console.warn('Cloudflare PIN 검증에 실패했습니다.', error);
    return null;
  }
}

function normalizeRemoteWatchlist(rawWatchlist) {
  if (!Array.isArray(rawWatchlist)) return [];
  return rawWatchlist.map(stock => ({
    ticker: stock.ticker,
    name: stock.name || getLocalCompanyProfile(stock.ticker).name,
    sector: stock.sector || getLocalCompanyProfile(stock.ticker).sector,
    exchange: stock.exchange || '',
    strategy: stock.strategy === 'dividend' ? 'dividend' : 'price',
    price: toNullableNumber(stock.price),
    change: toNullableNumber(stock.change),
    changePct: toNullableNumber(stock.changePct)
  }));
}

async function uploadWatchlistToCloudflare() {
  const apiUrl = getCloudflareApiUrl('/api/watchlist');
  if (!apiUrl || !state.apiPin) return false;

  // 예전 localStorage에는 전략 값이 없는 종목이 있으므로, 기존 티커 기반 분류를 저장 직전에 명시값으로 바꾼다.
  const watchlistForSync = state.watchlist.map(stock => ({
    ...stock,
    strategy: getInvestmentStrategy(stock)
  }));

  try {
    const response = await fetch(apiUrl, getCloudflareRequestOptions({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchlist: watchlistForSync })
    }));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return true;
  } catch (error) {
    // 네트워크 오류 시에도 로컬 저장본은 유지하여 사용자가 목록을 잃지 않게 한다.
    console.warn('Cloudflare 관심종목 저장에 실패했습니다.', error);
    return false;
  }
}

async function synchronizeWatchlistWithCloudflare() {
  if (!getCloudflareApiUrl('/api/dashboard') || !state.apiPin || state.watchlistSyncStarted) return;
  state.watchlistSyncStarted = true;

  try {
    let dashboard = await fetchDashboardSummaryFromCloudflare();
    const watchlist = dashboard?.watchlist;

    if (Array.isArray(watchlist) && watchlist.length > 0) {
      // D1 요약 응답 하나로 목록·현재가·일봉·배당 집계를 함께 반영한다.
      // 재무 10년 원본은 상세 분석을 열 때만 별도로 읽는다.
      state.watchlist = normalizeRemoteWatchlist(watchlist);
      const summaryByTicker = new Map((dashboard.stocks || []).map(stock => [stock.ticker, stock]));
      state.watchlist.forEach(stock => applyStoredCompanyToStock(stock, summaryByTicker.get(stock.ticker)));
      state.selectedTicker = state.watchlist[0]?.ticker || null;
      saveWatchlist(false);
      renderWatchlist();
      renderCompanyOverview();
      renderPortfolio();
      setStoredDataConnectionState(true);
    } else if (state.watchlist.length > 0) {
      // 첫 동기화만 현재 브라우저의 기존 목록을 D1로 옮긴다.
      const uploaded = await uploadWatchlistToCloudflare();
      // 업로드 직후에도 한 번만 요약을 다시 읽어, 기존 D1 데이터가 있으면 즉시 사용한다.
      dashboard = uploaded ? await fetchDashboardSummaryFromCloudflare() : null;
      if (dashboard?.watchlist?.length) {
        state.watchlist = normalizeRemoteWatchlist(dashboard.watchlist);
        const summaryByTicker = new Map((dashboard.stocks || []).map(stock => [stock.ticker, stock]));
        state.watchlist.forEach(stock => applyStoredCompanyToStock(stock, summaryByTicker.get(stock.ticker)));
        state.selectedTicker = state.watchlist[0]?.ticker || null;
        saveWatchlist(false);
        renderWatchlist();
        renderCompanyOverview();
        renderPortfolio();
      }
      setStoredDataConnectionState(true, '관심종목 저장 완료 · 상세 데이터 수집 대기');
    } else {
      setStoredDataConnectionState(true, '등록된 관심종목이 없습니다.');
    }
  } catch (error) {
    console.warn('Cloudflare 관심종목 동기화에 실패했습니다.', error);
    setStoredDataConnectionState(false);
  }
}

/** 초기 화면 전용 D1 요약. 종목별 상세 요청을 반복하지 않아 시작 속도를 유지한다. */
async function fetchDashboardSummaryFromCloudflare() {
  const apiUrl = getCloudflareApiUrl('/api/dashboard');
  if (!apiUrl || !state.apiPin) return null;
  const response = await fetch(apiUrl, getCloudflareRequestOptions());
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function applyStoredCompanyToStock(stock, company) {
  if (!stock || !company) return;
  stock.name = company.name || stock.name || stock.ticker;
  stock.sector = company.sector || stock.sector || '';
  stock.exchange = company.exchange || stock.exchange || '';
  const currentPrice = toNullableNumber(company.currentPrice);
  const previousClose = toNullableNumber(company.previousClose);
  const changeAmount = toNullableNumber(company.changeAmount);
  const changePercent = toNullableNumber(company.changePercent);
  stock.price = currentPrice ?? stock.price;
  stock.change = changeAmount ?? stock.change;
  // 공급원이 등락률을 비워도 D1에 있는 현재가·전일 종가로만 계산할 수 있다.
  // 두 원본 중 하나라도 없으면 숫자를 만들지 않고 그대로 미확보로 남긴다.
  stock.changePct = changePercent
    ?? (currentPrice !== null && previousClose !== null && previousClose !== 0
      ? ((currentPrice - previousClose) / previousClose) * 100
      : stock.changePct);
  // 재무·배당·일봉 원본은 localStorage에 저장하지 않고, 현재 세션에서만 사용한다.
  stock.marketData = company;
}

function setStoredDataConnectionState(isConnected, message = '') {
  const text = document.getElementById('marketStatusText');
  const indicator = document.querySelector('#marketBadge .status-indicator');
  if (text) text.textContent = message || (isConnected ? 'D1 저장 데이터 연결됨' : '저장 데이터 연결 실패');
  if (indicator) indicator.classList.toggle('live', isConnected);
}

async function updateStockProfileFromCloudflare(ticker) {
  const apiUrl = getCloudflareApiUrl(`/api/companies/${encodeURIComponent(ticker)}`);
  if (!apiUrl) {
    return;
  }

  try {
    const response = await fetch(apiUrl);
    if (!response.ok) {
      return;
    }

    const { company } = await response.json();
    const stock = state.watchlist.find(item => item.ticker === ticker);
    if (!company || !stock) {
      return;
    }

    applyStoredCompanyToStock(stock, company);
    saveWatchlist(false);
    renderWatchlist();
    if (ticker === state.selectedTicker) {
      renderCompanyDetailData(company);
      renderDetailCharts(company);
      updateCompanySummary();
    }
  } catch (error) {
    // 네트워크 실패는 화면 사용을 막지 않는다. 다음 동기화 또는 새로고침에서 다시 시도한다.
    console.warn('Cloudflare 회사 프로필을 불러오지 못했습니다.', error);
  }
}

/**
 * 신규 종목은 Worker에 최초 수집을 요청한다. Worker는 한 번에 한 데이터 종류만 처리하고,
 * 나머지는 Cron이 순차적으로 채운다. 이 방식은 무료 API의 호출 제한을 넘지 않기 위한 것이다.
 */
async function synchronizeStockDataWithCloudflare(ticker) {
  const apiUrl = getCloudflareApiUrl('/api/sync');
  if (!apiUrl || !state.apiPin) return;

  try {
    const response = await fetch(apiUrl, getCloudflareRequestOptions({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker })
    }));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await updateStockProfileFromCloudflare(ticker);
  } catch (error) {
    console.warn('Cloudflare 금융 데이터 최초 수집에 실패했습니다.', error);
  }
}

// 2. DOM 요소 캐싱
const pinScreen = document.getElementById('pinScreen');
const mainApp = document.getElementById('mainApp');
const pinDots = document.querySelectorAll('.pin-dots .dot');
const pinError = document.getElementById('pinError');
const tvChartContainer = document.getElementById('tvChartContainer');
const detailPriceChartContainer = document.getElementById('detailPriceChart');

// ========================================================
// 🔒 3. PIN 보안 잠금 화면
// ========================================================
function setupPinKeypad() {
  document.querySelectorAll('.key-btn[data-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      handlePinDigit(btn.getAttribute('data-key'));
    });
  });

  document.getElementById('pinDeleteBtn').addEventListener('click', () => {
    deletePinDigit();
  });

  document.getElementById('pinClearBtn').addEventListener('click', () => {
    clearPin();
  });

  // 키보드 숫자키 & 넘버패드 & 백스페이스 & 엔터 키 지원
  window.addEventListener('keydown', (e) => {
    // 잠금 화면이 닫혀 있으면 키보드 리스너 무시
    if (pinScreen.classList.contains('hidden')) return;

    // 모달창이 열려있을 때도 무시
    if (document.querySelector('.modal-overlay:not(.hidden)')) return;

    if (e.key >= '0' && e.key <= '9') {
      e.preventDefault();
      handlePinDigit(e.key);
    } else if (e.code && e.code.startsWith('Numpad') && e.code.length === 7) {
      const num = e.code.replace('Numpad', '');
      if (num >= '0' && num <= '9') {
        e.preventDefault();
        handlePinDigit(num);
      }
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      deletePinDigit();
    } else if (e.key === 'Escape' || e.key === 'Delete') {
      e.preventDefault();
      clearPin();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (state.enteredPin.length === 4) {
        validatePin();
      }
    }
  });

  // 즉시 잠그기 버튼
  document.getElementById('lockAppBtn').addEventListener('click', () => {
    lockApp();
  });
}

function handlePinDigit(digit) {
  if (state.enteredPin.length < 4) {
    state.enteredPin += digit;
    updatePinDots();
    if (state.enteredPin.length === 4) {
      setTimeout(validatePin, 100);
    }
  }
}

function deletePinDigit() {
  state.enteredPin = state.enteredPin.slice(0, -1);
  updatePinDots();
}

function clearPin() {
  state.enteredPin = '';
  updatePinDots();
}

function updatePinDots() {
  pinDots.forEach((dot, idx) => {
    dot.classList.toggle('filled', idx < state.enteredPin.length);
  });
  pinError.textContent = '';
}

async function validatePin() {
  const enteredPin = state.enteredPin;
  const remotePinResult = await verifyPinWithCloudflare(enteredPin);
  const isPinValid = remotePinResult === null
    ? enteredPin === state.currentPin
    : remotePinResult;

  if (isPinValid) {
    // 다른 브라우저에서는 Worker가 검증한 PIN을 로컬 잠금에도 사용한다.
    state.currentPin = enteredPin;
    state.apiPin = enteredPin;
    localStorage.setItem('stock_app_pin', enteredPin);
    unlockApp();
  } else {
    state.enteredPin = '';
    updatePinDots();
    pinError.textContent = '잘못된 PIN 번호입니다. 다시 입력해 주세요.';
  }
}

function unlockApp() {
  pinScreen.classList.add('hidden');
  mainApp.classList.remove('hidden');
  state.enteredPin = '';
  updatePinDots();
  initDashboard();
}

function lockApp() {
  destroyMainChart();
  destroyDetailChart();
  mainApp.classList.add('hidden');
  pinScreen.classList.remove('hidden');
  state.enteredPin = '';
  // 잠금 후에는 메모리에만 있던 Worker PIN도 제거한다.
  state.apiPin = '';
  state.watchlistSyncStarted = false;
  updatePinDots();
}

// ========================================================
// 📊 4. TradingView Advanced Chart 위젯
// ========================================================

function getSelectedStock() {
  return state.watchlist.find(item => item.ticker === state.selectedTicker) || null;
}

function isCompanyDetailOpen() {
  return !document.getElementById('companyDetailModal')?.classList.contains('hidden');
}

function isDetailChartTabActive() {
  return document.querySelector('.company-detail-tab.active')?.getAttribute('data-detail-tab') === 'chart';
}

/** 앱의 한글 조작 막대가 가리키는 설정을 모든 차트 위치에 동일하게 표시한다. */
function syncTradingViewControlState() {
  const { interval } = state.chartSettings;
  document.querySelectorAll('[data-chart-interval]').forEach(button => {
    const isActive = button.dataset.chartInterval === state.chartPreset;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });

  // FMP 저장값은 일봉이므로 분·시간·주봉 화면에 섞어 보이지 않게 일봉일 때만 노출한다.
  const ohlcBar = document.getElementById('chartOhlcBar');
  if (ohlcBar) ohlcBar.classList.toggle('hidden', interval !== 'D');
}

/**
 * TradingView 무료 위젯은 모든 분봉/기간 조합을 제공하지 않는다.
 * 위젯 모듈이 정한 호환 조합만 적용해, 버튼 표시와 iframe 내부 캔들 단위가 어긋나지 않게 한다.
 */
function applyTradingViewChartSettings(nextSettings, preset = state.chartPreset) {
  const normalizeSettings = window.TradingViewCharts?.normalizeSettings;
  const normalizedSettings = normalizeSettings
    ? normalizeSettings(nextSettings)
    : nextSettings;

  if (state.chartSettings.interval === normalizedSettings.interval
    && state.chartPreset === preset) return;

  state.chartSettings = normalizedSettings;
  state.chartPreset = preset;
  syncTradingViewControlState();
  renderActiveTradingViewChart();
}

/** 조작 버튼은 최초 한 번만 연결하고, 설정 변경 시 보이는 iframe만 다시 만든다. */
function setupTradingViewControls() {
  document.querySelectorAll('[data-chart-interval]').forEach(button => {
    button.addEventListener('click', () => {
      const nextInterval = button.dataset.chartInterval;
      if (!nextInterval) return;

      // 버튼명과 같은 실제 봉 단위만 위젯에 전달한다.
      const nextSettings = window.TradingViewCharts?.resolveForInterval?.(nextInterval)
        || { interval: nextInterval };
      applyTradingViewChartSettings(nextSettings, nextInterval);
    });
  });

  syncTradingViewControlState();
}

/** 현재 보이는 위치에만 외부 iframe을 생성해 불필요한 중복 렌더링을 막는다. */
function renderActiveTradingViewChart(stock = getSelectedStock()) {
  if (!stock || !window.TradingViewCharts) return;

  if (isCompanyDetailOpen() && isDetailChartTabActive()) {
    window.TradingViewCharts.unmount(tvChartContainer);
    window.TradingViewCharts.mount(detailPriceChartContainer, stock, state.chartSettings);
    return;
  }

  window.TradingViewCharts.unmount(detailPriceChartContainer);
  if (state.currentView === 'chart') {
    window.TradingViewCharts.mount(tvChartContainer, stock, state.chartSettings);
  } else {
    window.TradingViewCharts.unmount(tvChartContainer);
  }
}

function destroyMainChart() {
  window.TradingViewCharts?.unmount(tvChartContainer);
}

function destroyDetailChart() {
  window.TradingViewCharts?.unmount(detailPriceChartContainer);
}

function initChart() {
  syncTradingViewControlState();
  renderActiveTradingViewChart();
}

/** D1 응답에서 Williams %R과 최신 OHLC 계산에 사용할 수 있는 정상 일봉만 고른다. */
function normalizeChartCandles(company) {
  return (company?.candles || []).map(candle => ({
    time: candle.candleDate,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume) || 0
  })).filter(candle => candle.time && [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite));
}

/** 저장된 신호가 같은 일봉까지 계산되었으면 D1 상태를 우선해 기기별 표시를 일치시킨다. */
function getWilliamsSummary(candles, storedSummary = null) {
  const localSummary = window.WilliamsSignalEngine?.summarize(candles);
  if (!localSummary) return null;
  return storedSummary?.lastCandleDate === localSummary.lastCandleDate
    && Number.isFinite(storedSummary.value) && storedSummary.signal?.label
    ? storedSummary : localSummary;
}

function renderDetailCharts(company) {
  const stock = getSelectedStock();
  if (!stock) return;
  if (company?.exchange) stock.exchange = company.exchange;
  document.getElementById('detailChartEmptyState')?.classList.add('hidden');
  renderActiveTradingViewChart(stock);
}

async function fetchCompanyFromCloudflare(ticker) {
  const apiUrl = getCloudflareApiUrl(`/api/companies/${encodeURIComponent(ticker)}`);
  if (!apiUrl) return null;
  const controller = new AbortController();
  // D1 읽기 자체가 느려진 경우에도 한 종목의 요청이 전체 종합 화면을 멈추게 하지 않는다.
  const timeoutId = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(apiUrl, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()).company || null;
  } catch (error) {
    console.warn('저장된 회사 데이터를 불러오지 못했습니다.', error);
    return null;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

/**
 * 차트 자체는 TradingView가 표시하고, FMP 3개월 일봉은 Williams %R·목록·최신 OHLC에 계속 사용한다.
 * 신규 종목은 거래소 조회를 기다리지 않고 티커로 먼저 표시한 뒤 회사 프로필이 도착하면 자동 보정한다.
 */
async function loadStockChart(ticker) {
  const stock = state.watchlist.find(item => item.ticker === ticker);
  if (!stock) return;

  document.getElementById('chartTicker').textContent = stock.ticker;
  document.getElementById('chartCompanyName').textContent = stock.name;
  document.getElementById('chartPrice').textContent = formatCurrency(stock.price);
  const initialChangeElement = document.getElementById('chartChange');
  initialChangeElement.className = `price-change ${getChangeDirectionClass(stock.change)}`;
  initialChangeElement.textContent = formatPriceChange(stock.change, stock.changePct);
  renderActiveTradingViewChart(stock);

  const company = await fetchCompanyFromCloudflare(ticker);
  if (ticker !== state.selectedTicker || !company) return;

  applyStoredCompanyToStock(stock, company);
  saveWatchlist(false);
  renderCompanyDetailData(company);
  renderDetailCharts(company);
  updateCompanySummary();

  document.getElementById('chartTicker').textContent = stock.ticker;
  document.getElementById('chartCompanyName').textContent = stock.name;
  document.getElementById('chartPrice').textContent = formatCurrency(stock.price);
  const changeElem = document.getElementById('chartChange');
  changeElem.className = `price-change ${getChangeDirectionClass(stock.change)}`;
  changeElem.textContent = formatPriceChange(stock.change, stock.changePct);

  const candles = normalizeChartCandles(company);
  const latestCandle = candles.at(-1);
  const latestValues = {
    ohlcOpen: latestCandle ? formatUsdValue(latestCandle.open) : '데이터 없음',
    ohlcHigh: latestCandle ? formatUsdValue(latestCandle.high) : '데이터 없음',
    ohlcLow: latestCandle ? formatUsdValue(latestCandle.low) : '데이터 없음',
    ohlcClose: latestCandle ? formatUsdValue(latestCandle.close) : '데이터 없음',
    ohlcVol: latestCandle ? latestCandle.volume.toLocaleString() : '-'
  };
  Object.entries(latestValues).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });
  renderActiveTradingViewChart(stock);
}

// ========================================================
// 📋 5. [1번 메인메뉴] 주식 목록 관리 (Submenu 1-1, 1-2, 1-3, 1-4)
// ========================================================

/**
 * [서브메뉴 1-1] 신규 주식 종목 추가 함수
 * 사용자가 입력한 순서를 보존하기 위해 배열 끝에 추가(push)하고 로컬스토리지에 저장합니다.
 */
function addNewStock(ticker, strategy = 'price') {
  ticker = (ticker || '').trim().toUpperCase();

  if (!ticker) {
    alert('주식 티커 심볼을 입력해 주세요. (예: AAPL, NVDA)');
    return false;
  }

  // 중복 등록 방지
  const isDuplicate = state.watchlist.some(s => s.ticker === ticker);
  if (isDuplicate) {
    alert(`[${ticker}] 이미 등록되어 있는 종목입니다.`);
    return false;
  }

  // 신규 종목은 임의 시세를 만들지 않는다. D1 수집이 끝날 때까지 저장 대기로 표시한다.
  const profile = getLocalCompanyProfile(ticker);
  const newStock = {
    ticker,
    // API 연동 전에는 제한된 로컬 사전 정보만 사용하고, 그 외 종목은 자동 조회 대기로 둡니다.
    name: profile.name,
    sector: profile.sector,
    strategy,
    price: null,
    change: null,
    changePct: null
  };

  state.watchlist.push(newStock);
  // 새로 추가한 종목을 즉시 현재 종목으로 선택해 2번 차트와 상세 분석에서 바로 사용할 수 있게 한다.
  state.selectedTicker = ticker;
  saveWatchlist();
  renderWatchlist();
  updateCompanySummary();
  loadStockChart(ticker);
  // 관심종목 저장을 먼저 요청한 뒤 최초 금융 이력을 수집한다.
  void synchronizeStockDataWithCloudflare(ticker);

  return true;
}

/**
 * 프로필 API 연결 전 화면을 유지하기 위한 최소 로컬 사전입니다.
 * 실제 구현에서는 서버의 회사 프로필 API 결과로 name·sector를 덮어씁니다.
 */
function getLocalCompanyProfile(ticker) {
  const profiles = {
    NVDA: { name: 'NVIDIA Corporation', sector: '기술' },
    AAPL: { name: 'Apple Inc.', sector: '기술' },
    TSLA: { name: 'Tesla, Inc.', sector: '경기소비재' },
    MSFT: { name: 'Microsoft Corp.', sector: '기술' },
    AMZN: { name: 'Amazon.com Inc.', sector: '경기소비재' },
    O: { name: 'Realty Income Corp.', sector: '부동산' },
    JPM: { name: 'JPMorgan Chase & Co.', sector: '금융' },
    KO: { name: 'Coca-Cola Company', sector: '필수소비재' }
  };
  return profiles[ticker] || { name: `${ticker} · 프로필 조회 대기`, sector: '섹터 조회 대기' };
}

function getStockSector(stock) {
  return stock.sector || getLocalCompanyProfile(stock.ticker).sector;
}

/**
 * [서브메뉴 1-4] 종목 삭제 함수
 * 선택된 종목을 목록에서 제거하고, 순서를 유지한 채 로컬스토리지에 저장합니다.
 */
function deleteStock(ticker) {
  const stock = state.watchlist.find(s => s.ticker === ticker);
  const displayName = stock ? `${stock.ticker} (${stock.name})` : ticker;

  if (!confirm(`[${displayName}] 종목을 목록에서 삭제하시겠습니까?`)) {
    return;
  }

  // 목록에서 제외 (남은 종목들의 순서는 그대로 유지)
  state.watchlist = state.watchlist.filter(s => s.ticker !== ticker);
  saveWatchlist();

  // 삭제된 종목이 현재 차트에 표시 중이었다면 다른 종목으로 안전하게 전환
  if (state.selectedTicker === ticker) {
    if (state.watchlist.length > 0) {
      state.selectedTicker = state.watchlist[0].ticker;
      loadStockChart(state.selectedTicker);
    } else {
      state.selectedTicker = null;
    }
  }

  renderWatchlist();
}

/**
 * [서브메뉴 1-3] 드래그 앤 드롭 순서 변경 함수
 * 사용자가 끌어다 놓은 위치(fromIndex -> toIndex)로 배열 원소를 이동시켜 순서를 영구 보존합니다.
 */
function reorderWatchlist(fromIndex, toIndex) {
  if (fromIndex < 0 || fromIndex >= state.watchlist.length) return;
  if (toIndex < 0 || toIndex >= state.watchlist.length) return;
  if (fromIndex === toIndex) return;

  // 원소 추출 후 새 위치에 삽입
  const movedItem = state.watchlist.splice(fromIndex, 1)[0];
  state.watchlist.splice(toIndex, 0, movedItem);

  // 로컬스토리지에 변경된 사용자 순서 즉시 저장
  saveWatchlist();
  // UI 갱신 (변경된 순번 1, 2, 3... 반영)
  renderWatchlist();
}

// 드래그 중인 인덱스 추적 변수
let draggedItemIndex = null;

/** 1번 종합은 D1에 저장된 일봉·배당 집계값만 사용한다. */
function renderCompanyOverview() {
  const priorityList = document.getElementById('priorityCompanyList');
  const dividendList = document.getElementById('dividendCompanyList');
  const priceList = document.getElementById('priceCompanyList');
  const count = document.getElementById('overviewCompanyCount');
  if (!priorityList || !dividendList || !priceList || !count) return;

  count.textContent = `${state.watchlist.length}종목`;

  if (state.watchlist.length === 0) {
    const emptyMessage = '<p class="company-explorer-help">4번 주식 목록 관리에서 회사를 추가해 주세요.</p>';
    priorityList.innerHTML = emptyMessage;
    dividendList.innerHTML = emptyMessage;
    priceList.innerHTML = emptyMessage;
    return;
  }

  const dividendStocks = state.watchlist.filter(stock => getInvestmentStrategy(stock) === 'dividend');
  const priceStocks = state.watchlist.filter(stock => getInvestmentStrategy(stock) === 'price');
  const priorityStocks = [...state.watchlist]
    .sort((first, second) => (getStoredWilliams(first)?.value ?? Infinity) - (getStoredWilliams(second)?.value ?? Infinity))
    .slice(0, 3);

  renderOverviewStockRows(priorityList, priorityStocks, '오늘은 우선 확인할 종목이 없습니다.', 'auto');
  renderOverviewStockRows(dividendList, dividendStocks, '배당 투자 종목이 없습니다. 4번 목록에서 전략을 지정해 주세요.', true);
  renderOverviewStockRows(priceList, priceStocks, '주가 투자 종목이 없습니다. 4번 목록에서 전략을 지정해 주세요.', false);
  updateCompanySummary();
}

/** 현재는 티커 기반 기본 분류이며, 이후 4번 목록의 전략 선택값을 우선 사용합니다. */
function getInvestmentStrategy(stock) {
  if (stock.strategy === 'dividend' || stock.strategy === 'price') return stock.strategy;
  const dividendTickers = new Set(['O', 'JPM', 'ABBV', 'ABT', 'GD', 'PG', 'CAT', 'MS', 'TXN', 'XOM', 'CVX', 'KO', 'PEP', 'MCD', 'MO', 'ARCC', 'BXSL']);
  return dividendTickers.has(stock.ticker) ? 'dividend' : 'price';
}

function renderOverviewStockRows(container, stocks, emptyMessage, showDividendDetails) {
  container.innerHTML = '';
  if (stocks.length === 0) {
    container.innerHTML = `<p class="company-explorer-help">${emptyMessage}</p>`;
    return;
  }

  stocks.forEach(stock => {
    const shouldShowDividendDetails = showDividendDetails === 'auto'
      ? getInvestmentStrategy(stock) === 'dividend'
      : showDividendDetails;
    const williams = getStoredWilliams(stock);
    const signal = williams?.signal || { label: '일봉 저장 대기', className: 'pending' };
    const dividend = getStoredDividendInfo(stock);
    const priceDirection = getChangeDirectionClass(stock.change);
    const sparkline = createStoredSparkline(stock, williams);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `overview-stock-row ${shouldShowDividendDetails ? '' : 'price-stock-row'} ${stock.ticker === state.selectedTicker ? 'active' : ''}`;
    item.innerHTML = `
      <span class="overview-company-cell"><strong>${escapeHtml(stock.ticker)}</strong><span title="${escapeHtml(stock.name || stock.ticker)}">${escapeHtml(stock.name || '회사 정보 저장 대기')}</span></span>
      <span class="overview-price-cell"><strong>${formatCurrency(stock.price)}</strong><span class="${priceDirection}">${formatPercent(stock.changePct)}</span></span>
      ${sparkline || `<span class="overview-sparkline overview-pending-sparkline">일봉 저장 대기</span>`}
      <span class="overview-williams-cell"><span class="overview-williams-value">${williams ? williams.value.toFixed(1) : '—'}</span><span class="overview-value-label">Williams %R (14일)</span></span>
      <span class="overview-signal-cell"><span class="overview-signal ${signal.className}">${escapeHtml(signal.label)}</span><span class="overview-value-label">${escapeHtml(signal.since ? `${formatMonthDay(signal.since)} 일봉 신호` : '저장 일봉 기준')}</span></span>
      ${shouldShowDividendDetails ? `
        <span class="overview-next-dividend-cell ${dividend.status}"><strong>${dividend.nextDate}</strong><span>${dividend.statusLabel}</span></span>
        <span class="overview-dividend-day-cell ${dividend.status}"><strong>${dividend.daysLeft}</strong><span>주말 제외 남은 일수</span></span>
        <span class="overview-dividend-cell"><strong>${dividend.yieldRate}</strong><span>${dividend.yieldDetail}</span></span>
      ` : ''}
    `;
    item.addEventListener('click', () => {
      state.selectedTicker = stock.ticker;
      loadStockChart(stock.ticker);
      renderWatchlist();
      renderCompanyOverview();
      openCompanyDetailModal();
    });
    container.appendChild(item);
  });
}

function getStoredWilliams(stock) {
  return getWilliamsSummary(normalizeChartCandles(stock.marketData), stock.marketData?.technicalSignal);
}

/** 배당 화면은 SEC 기간 집계와 별도 FMP 지급 이벤트를 항목별로 표시한다. */
function getStoredDividendInfo(stock) {
  const dividend = stock.marketData?.dividendMetrics;
  const annualDividend = toNullableNumber(dividend?.annualDividend);
  const yieldValue = toNullableNumber(dividend?.dividendYield);
  const paymentDate = dividend?.nextPaymentDate;
  const nextDate = paymentDate || dividend?.nextExDividendDate;
  const status = ['confirmed', 'estimated'].includes(dividend?.nextDateStatus)
    ? dividend.nextDateStatus : 'unknown';
  return {
    yieldRate: yieldValue === null ? '—' : `${yieldValue.toFixed(2)}%`,
    yieldDetail: yieldValue !== null
      ? `FMP 실제 지급 ${dividend.trailingPayoutCount}회 · 저장 현재가 기준`
      : annualDividend === null ? '배당수익률 미확보' : `수익률 미확보 · SEC 연간 ${formatSecDividendAmount(annualDividend)}`,
    nextDate: nextDate ? formatMonthDay(nextDate) : '미정',
    daysLeft: nextDate ? formatWeekdayCountdown(nextDate) : '—',
    status,
    statusLabel: status === 'confirmed' ? (paymentDate ? '확정 지급일' : '확정 배당락일')
      : status === 'estimated' ? (paymentDate ? '미확정 지급일' : '예상 배당락일') : '배당일 미확보'
  };
}

/** 사용자가 요청한 D-day는 미국 휴장일 API 없이 주말만 제외한다. */
function formatWeekdayCountdown(nextDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(nextDate || ''))) return '—';
  const todayText = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric',
    month: '2-digit', day: '2-digit' }).format(new Date());
  const start = new Date(`${todayText}T00:00:00Z`);
  const end = new Date(`${nextDate}T00:00:00Z`);
  if (!Number.isFinite(end.getTime())) return '—';
  if (end <= start) return 'D-0';
  let weekdays = 0;
  for (let day = new Date(start.getTime() + 86_400_000); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    if (![0, 6].includes(day.getUTCDay())) weekdays += 1;
  }
  return `D-${weekdays}`;
}

/** 최근 13개 저장 종가의 추이를 그리되, 선 색은 현재 14일 Williams %R 구간으로 표시한다. */
function createStoredSparkline(stock, williams) {
  const closes = normalizeChartCandles(stock.marketData).map(candle => candle.close).slice(-13);
  if (closes.length < 2) return '';
  const lowest = Math.min(...closes);
  const highest = Math.max(...closes);
  const range = highest - lowest || 1;
  const points = closes.map((close, index) => {
    const x = (index / (closes.length - 1)) * 110;
    const y = 31 - ((close - lowest) / range) * 27;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const zoneClass = ['buy', 'hold', 'sell'].includes(williams?.zoneClass) ? williams.zoneClass : 'pending';
  return `<svg class="overview-sparkline ${zoneClass}" viewBox="0 0 110 35" role="img" aria-label="${escapeHtml(stock.ticker)} 최근 ${closes.length}거래일 주가 추이, ${escapeHtml(williams?.status || '지표 계산 대기')}"><polyline points="${points}"></polyline></svg>`;
}

function updateCompanySummary() {
  const stock = state.watchlist.find(item => item.ticker === state.selectedTicker) || state.watchlist[0];
  if (!stock) {
    ['overviewTicker', 'overviewCompanyName', 'overviewPrice', 'overviewChange', 'detailTicker', 'detailCompanyName', 'detailPrice', 'detailChange']
      .forEach(id => { const element = document.getElementById(id); if (element) element.textContent = '데이터 없음'; });
    return;
  }

  const directionClass = getChangeDirectionClass(stock.change);
  const changeText = formatPriceChange(stock.change, stock.changePct);
  const summaryFields = {
    overviewTicker: stock.ticker,
    overviewCompanyName: stock.name,
    overviewPrice: formatCurrency(stock.price),
    overviewChange: changeText,
    detailTicker: stock.ticker,
    detailCompanyName: stock.name,
    detailPrice: formatCurrency(stock.price),
    detailChange: formatPercent(stock.changePct),
    chartTicker: stock.ticker,
    chartCompanyName: stock.name,
    chartPrice: formatCurrency(stock.price),
    chartChange: changeText
  };

  Object.entries(summaryFields).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });
  ['overviewChange', 'detailChange'].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.className = directionClass;
  });
  const chartChange = document.getElementById('chartChange');
  if (chartChange) chartChange.className = `price-change ${directionClass}`;

  const williams = getStoredWilliams(stock);
  const detailFields = {
    detailWilliamsR: williams ? williams.value.toFixed(1) : '데이터 수집 대기',
    detailWilliamsSignal: williams ? williams.status : '14일 일봉 수집 대기',
    detailInvestmentSignal: williams
      ? `${williams.signal.label}${williams.signal.reviewLabel ? ` · ${williams.signal.reviewLabel}` : ''}${williams.signal.since ? ` (${formatMonthDay(williams.signal.since)} 일봉)` : ''}`
      : '판단 보류'
  };
  Object.entries(detailFields).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });
}

function formatMetricValue(value, suffix = '') {
  const number = toNullableNumber(value);
  return number === null ? '데이터 없음' : `${number.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

/** SEC 주당배당금은 0.001달러 단위도 있으므로 일반 재무 카드보다 정밀하게 표시한다. */
function formatSecDividendAmount(value) {
  const amount = toNullableNumber(value);
  return amount === null ? '데이터 없음' : `$${amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

/** 상세 모달의 재무·배당 카드는 D1 원본 집계값만 표시한다. */
function renderCompanyDetailData(company) {
  const financialContainer = document.getElementById('detailFinancialMetrics');
  const dividendContainer = document.getElementById('detailDividendMetrics');
  if (!financialContainer || !dividendContainer) return;

  const quarterlyFinancials = (company.financials || []).filter(item => item.periodType === 'quarterly');
  // 최신 공시의 부족한 항목은 그대로 표시한다. 과거의 완전한 행으로 몰래 바꾸지 않는다.
  const financial = quarterlyFinancials[0] || company.financials?.[0];
  const financialEntries = [
    ['매출', financial?.revenue, '$'], ['영업이익', financial?.operatingIncome, '$'],
    ['순이익', financial?.netIncome, '$'], ['EPS', financial?.eps, '$'],
    ['PEG', financial?.pegRatio, ''], ['PER', financial?.peRatio, ''], ['P/S', financial?.psRatio, ''],
    ['잉여현금흐름', financial?.freeCashFlow, '$'], ['ROE', financial?.roe, '%'],
    ['ROIC', financial?.roic, '%'], ['Gross Margin', financial?.grossMargin, '%'], ['Oper. Margin', financial?.operatingMargin, '%']
  ];
  financialContainer.innerHTML = financialEntries.map(([label, value, suffix]) =>
    `<div class="company-metric"><span>${label}</span><strong>${formatMetricValue(value, suffix)}</strong></div>`).join('');
  document.getElementById('detailFinancialSource').textContent = financial
    ? `${financial.periodType === 'quarterly' ? '분기' : '연간'} ${financial.fiscalPeriodEnd} · ${financial.source} 저장값 · 미확보 지표/이력 범위는 5-3 수집 현황에서 확인`
    : '아직 저장된 재무 데이터가 없습니다.';

  const dividend = company.dividendMetrics;
  const yieldValue = toNullableNumber(dividend?.dividendYield);
  const nextStatus = dividend?.nextDateStatus || 'unknown';
  const dividendEntries = [
    ['최근 실제 지급 1년 배당수익률', yieldValue === null ? '미확보' : `${yieldValue.toFixed(2)}%`,
      yieldValue === null ? 'FMP 지급 이벤트 또는 저장 현재가 미확보' : `FMP 실제 지급 ${dividend.trailingPayoutCount}회 합계 ÷ 저장 현재가`, yieldValue === null ? 'unknown' : 'confirmed'],
    ['SEC 최근 연간 주당배당금', formatSecDividendAmount(dividend?.annualDividend), dividend?.annualPeriodEnd || '기간 미확보'],
    ['SEC 최근 분기 주당배당금', formatSecDividendAmount(dividend?.quarterlyDividend), dividend?.quarterlyPeriodEnd || '기간 미확보'],
    ['마지막 실제 지급 배당금', formatSecDividendAmount(dividend?.lastPaidAmount),
      dividend?.lastPaymentDate || 'FMP 지급 이벤트 미확보', dividend?.lastPaidAmount == null ? 'unknown' : 'confirmed'],
    ['확보 이력 내 배당 성장 연수', dividend?.dividendGrowthYears, '년'], ['10년 배당 성장률', dividend?.dividendGrowthCagr10y, '%'],
    ['다음 배당락일', dividend?.nextExDividendDate || '미확보',
      dividend?.nextExDividendDate ? `${dividend.nextDateSource || 'FMP 일정'} · ${formatWeekdayCountdown(dividend.nextExDividendDate)}` : 'FMP 미래 일정 미확보', nextStatus],
    ['다음 배당 지급일', dividend?.nextPaymentDate || '미확보',
      dividend?.nextPaymentDate ? `FMP 일정 · ${formatWeekdayCountdown(dividend.nextPaymentDate)}` : '지급일 공시 미확보', dividend?.nextPaymentDate ? nextStatus : 'unknown'],
    ['날짜 상태', nextStatus === 'confirmed' ? '확정' : nextStatus === 'estimated' ? '미확정' : '미확보',
      nextStatus === 'confirmed' ? '공시일 확인' : '확정 공시 없음', nextStatus]
  ];
  dividendContainer.innerHTML = dividendEntries.map(([label, value, suffix, status]) => {
    const displayValue = typeof value === 'string' ? value : formatMetricValue(value, suffix);
    const detail = suffix && typeof value === 'string' ? `<small>${escapeHtml(suffix)}</small>` : '';
    return `<div class="company-metric${status ? ` dividend-date ${status}` : ''}"><span>${label}</span><strong>${escapeHtml(displayValue)}</strong>${detail}</div>`;
  }).join('');
  document.getElementById('detailDividendSource').textContent = `연·분기 배당금과 성장: SEC EDGAR · 실제 지급 수익률과 배당락일: FMP 지급 이벤트${dividend?.eventCount ? ` ${dividend.eventCount}개` : ' 미확보'}. 현재가가 없거나 FMP 접근이 제한된 종목은 계산하지 않습니다.`;
}

/**
 * [서브메뉴 4-2] 주식 목록 렌더링 & [4-3] 드래그 앤 드롭 이벤트 바인딩
 * 종합 대시보드의 목록을 사용자가 직접 구성한 순서대로 표시합니다.
 */
function renderWatchlist() {
  const dividendContainer = document.getElementById('dividendWatchlistContainer');
  const priceContainer = document.getElementById('priceWatchlistContainer');
  if (!dividendContainer || !priceContainer) return;
  dividendContainer.innerHTML = '';
  priceContainer.innerHTML = '';

  const dividendStocks = state.watchlist.filter(stock => getInvestmentStrategy(stock) === 'dividend');
  const priceStocks = state.watchlist.filter(stock => getInvestmentStrategy(stock) === 'price');
  document.getElementById('dividendWatchlistCount').textContent = `${dividendStocks.length}종목`;
  document.getElementById('priceWatchlistCount').textContent = `${priceStocks.length}종목`;

  // 종목 개수 뱃지 갱신
  document.querySelectorAll('.ov-watchlist-count').forEach(b => {
    b.textContent = `${state.watchlist.length}종목`;
  });

  // 등록된 종목이 없을 때의 안내 화면
  if (state.watchlist.length === 0) {
    const emptyContent = `
      <div class="watchlist-empty">
        <i class="fa-solid fa-layer-group"></i>
        <p>등록된 종목이 없습니다.<br>위 입력창에서 종목을 추가해 보세요!</p>
      </div>
    `;
    dividendContainer.innerHTML = emptyContent;
    priceContainer.innerHTML = emptyContent;
    renderCompanyOverview();
    return;
  }

  if (dividendStocks.length === 0) dividendContainer.innerHTML = '<div class="watchlist-empty compact-empty"><p>배당 투자 종목이 없습니다.</p></div>';
  if (priceStocks.length === 0) priceContainer.innerHTML = '<div class="watchlist-empty compact-empty"><p>주가 투자 종목이 없습니다.</p></div>';

  // 사용자가 입력 및 드래그 정렬한 순서대로 순회
  state.watchlist.forEach((stock, index) => {
    const strategy = getInvestmentStrategy(stock);
    const targetContainer = strategy === 'dividend' ? dividendContainer : priceContainer;
    const isSelected = stock.ticker === state.selectedTicker;

    const item = document.createElement('div');
    item.className = `stock-item ${isSelected ? 'active' : ''}`;
    item.setAttribute('draggable', 'true');
    item.setAttribute('data-index', index);
    item.setAttribute('data-ticker', stock.ticker);
    item.setAttribute('data-strategy', strategy);

    item.innerHTML = `
      <div class="drag-handle" title="위아래로 드래그하여 순서 변경 (1-3)">
        <i class="fa-solid fa-grip-vertical"></i>
      </div>
      <span class="stock-order-badge" title="사용자 등록 순번">${index + 1}</span>
      <div class="stock-item-left">
        <span class="stock-item-ticker">${escapeHtml(stock.ticker)}</span>
        <span class="stock-item-name">${escapeHtml(stock.name || '회사 정보 저장 대기')}</span>
        <span class="stock-item-meta"><span class="strategy-badge ${strategy}">${strategy === 'dividend' ? '배당 투자' : '주가 투자'}</span>${escapeHtml(getStockSector(stock))}</span>
      </div>
      <!-- 4번은 종목 추가·분류·정렬 관리만 담당하므로 시세·등락률을 표시하지 않는다. -->
      <button class="btn-delete-stock" title="${stock.ticker} 종목 삭제 (1-4)" data-ticker="${stock.ticker}">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    `;

    // --- 1-3. 데스크톱 HTML5 Drag & Drop 이벤트 바인딩 ---
    item.addEventListener('dragstart', (e) => {
      draggedItemIndex = index;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
      // 드래그 시작 시 반투명 시각 피드백 부여
      setTimeout(() => item.classList.add('dragging'), 0);
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      document.querySelectorAll('.stock-item').forEach(el => el.classList.remove('drag-over'));
      draggedItemIndex = null;
    });

    item.addEventListener('dragover', (e) => {
      const draggedItem = document.querySelector('.stock-item.dragging');
      if (draggedItem && draggedItem.getAttribute('data-strategy') !== strategy) return;
      e.preventDefault(); // drop 이벤트를 허용하기 위해 필수
      e.dataTransfer.dropEffect = 'move';
      if (draggedItemIndex !== null && draggedItemIndex !== index) {
        item.classList.add('drag-over');
      }
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const toIdx = index;
      const sourceStock = state.watchlist[fromIdx];
      if (sourceStock && getInvestmentStrategy(sourceStock) === strategy && fromIdx !== toIdx) {
        reorderWatchlist(fromIdx, toIdx);
      }
    });

    // --- 1-3. 모바일 터치 드래그 바인딩 (그립 핸들 터치 시) ---
    setupMobileTouchDrag(item, index);

    // 종목 카드 클릭 시 차트 로드 (삭제 버튼이나 핸들 클릭은 제외)
    item.addEventListener('click', (e) => {
      if (e.target.closest('.btn-delete-stock') || e.target.closest('.drag-handle')) {
        return;
      }
      state.selectedTicker = stock.ticker;
      renderWatchlist();
      loadStockChart(stock.ticker);
      
    });

    // --- 1-4. 삭제 버튼 클릭 이벤트 바인딩 ---
    const deleteBtn = item.querySelector('.btn-delete-stock');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteStock(stock.ticker);
      });
    }

    targetContainer.appendChild(item);
  });

  renderCompanyOverview();
}

/**
 * 1-3. 모바일 터치 드래그 앤 드롭 보조 함수
 * 스마트폰 터치 환경에서도 위아래로 끌어 순서를 바꿀 수 있도록 구현합니다.
 */
let touchStartIndex = null;
let touchCurrentTargetIndex = null;

function setupMobileTouchDrag(itemElem, index) {
  const handle = itemElem.querySelector('.drag-handle');
  if (!handle) return;

  handle.addEventListener('touchstart', (e) => {
    touchStartIndex = index;
    touchCurrentTargetIndex = null;
    itemElem.classList.add('touch-dragging');
  }, { passive: true });

  handle.addEventListener('touchmove', (e) => {
    const touch = e.touches[0];
    const elemUnderTouch = document.elementFromPoint(touch.clientX, touch.clientY);
    const targetItem = elemUnderTouch ? elemUnderTouch.closest('.stock-item') : null;

    document.querySelectorAll('.stock-item').forEach(el => el.classList.remove('drag-over'));

    if (targetItem && targetItem !== itemElem && targetItem.getAttribute('data-strategy') === itemElem.getAttribute('data-strategy')) {
      targetItem.classList.add('drag-over');
      touchCurrentTargetIndex = parseInt(targetItem.getAttribute('data-index'), 10);
    }
  }, { passive: true });

  handle.addEventListener('touchend', () => {
    itemElem.classList.remove('touch-dragging');
    document.querySelectorAll('.stock-item').forEach(el => el.classList.remove('drag-over'));

    if (touchStartIndex !== null && touchCurrentTargetIndex !== null && touchStartIndex !== touchCurrentTargetIndex) {
      reorderWatchlist(touchStartIndex, touchCurrentTargetIndex);
    }
    touchStartIndex = null;
    touchCurrentTargetIndex = null;
  });
}

/**
 * [4-1] 종합 대시보드의 빠른 추가 폼을 관심종목 상태에 연결합니다.
 */
function setupOverviewQuickAdd() {
  const forms = document.querySelectorAll('.strategy-quick-add');
  forms.forEach(form => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const tickerInput = form.querySelector('.strategy-ticker');
      const ticker = tickerInput ? tickerInput.value.trim().toUpperCase() : '';
      const strategy = form.getAttribute('data-strategy') || 'price';
      if (addNewStock(ticker, strategy)) {
        if (tickerInput) { tickerInput.value = ''; tickerInput.focus(); }
      }
    });
  });
}

// ========================================================
// 💼 6. 내 포트폴리오 렌더링 & 손익 계산
// ========================================================

/**
 * 포트폴리오 렌더링 핵심 로직 (재사용 가능)
 * @param {string} tbodyId - 테이블 tbody의 ID
 * @param {string} totalValId - 총평가금액 span ID
 * @param {string} totalValKrwId - 총평가금액 원화 span ID
 * @param {string} totalPnlId - 총손익 span ID
 * @param {string} totalPnlKrwId - 총손익 원화 span ID
 */
function renderPortfolioToTarget(tbodyId, totalValId, totalValKrwId, totalPnlId, totalPnlKrwId) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = '';

  let totalBuyAmount = 0;
  let totalCurrentAmount = 0;
  let pendingQuoteCount = 0;

  state.holdings.forEach(holding => {
    const stock = state.watchlist.find(s => s.ticker === holding.ticker);
    // 현재가는 반드시 D1에 저장된 값만 사용한다. 값이 없을 때 임의 수익률을 적용하면
    // 포트폴리오 손익이 실제처럼 오해될 수 있으므로, 해당 보유분은 평가 대기로 남긴다.
    const currentPrice = toNullableNumber(stock?.price);

    const buyVal = holding.qty * holding.buyPrice;
    const curVal = currentPrice === null ? null : holding.qty * currentPrice;
    const pnl = curVal === null ? null : curVal - buyVal;
    const pnlPct = pnl === null || buyVal <= 0 ? null : (pnl / buyVal) * 100;
    const directionClass = getChangeDirectionClass(pnl);

    totalBuyAmount += buyVal;
    if (curVal === null) {
      pendingQuoteCount += 1;
    } else {
      totalCurrentAmount += curVal;
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(holding.ticker)}</strong></td>
      <td>${holding.qty}주</td>
      <td>${formatUsdValue(holding.buyPrice)}</td>
      <td>${formatCurrency(currentPrice)}</td>
      <td class="${directionClass}">
        <strong>${pnl === null ? '현재가 저장 대기' : formatPriceChange(pnl, pnlPct)}</strong>
        ${pnl === null ? '<br><small>저장된 현재가가 도착하면 계산합니다.</small>' : ''}
      </td>
      <td>
        <button class="btn-delete-holding" data-id="${holding.id}" title="삭제">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // 총계 표시
  // 일부 현재가가 없으면 합계 손익도 완전한 값이 아니므로 숫자로 단정하지 않는다.
  const hasCompleteValuation = pendingQuoteCount === 0;
  const totalPnl = hasCompleteValuation ? totalCurrentAmount - totalBuyAmount : null;
  const totalPnlPct = totalPnl === null || totalBuyAmount <= 0 ? null : (totalPnl / totalBuyAmount) * 100;
  const totalDirectionClass = getChangeDirectionClass(totalPnl);

  const valElem = document.getElementById(totalValId);
  const valKrwElem = document.getElementById(totalValKrwId);
  const pnlElem = document.getElementById(totalPnlId);
  const pnlKrwElem = document.getElementById(totalPnlKrwId);

  if (valElem) valElem.textContent = hasCompleteValuation ? formatCurrency(totalCurrentAmount) : '평가 대기';
  if (valKrwElem) {
    valKrwElem.textContent = hasCompleteValuation && hasStoredNumber(state.usdKrwRate)
      ? `≈ ${Math.round(totalCurrentAmount * state.usdKrwRate).toLocaleString()}원`
      : hasCompleteValuation ? '환율 데이터 미연동' : `${pendingQuoteCount}개 종목 현재가 저장 대기`;
  }
  if (pnlElem) {
    pnlElem.className = `value ${totalDirectionClass}`;
    pnlElem.textContent = totalPnl === null ? '손익 계산 대기' : formatPriceChange(totalPnl, totalPnlPct);
  }
  if (pnlKrwElem) {
    pnlKrwElem.textContent = totalPnl !== null && hasStoredNumber(state.usdKrwRate)
      ? `≈ ${totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl * state.usdKrwRate).toLocaleString()}원`
      : totalPnl !== null ? '환율 데이터 미연동' : '현재가 저장 후 계산';
  }

  // 삭제 버튼 이벤트
  tbody.querySelectorAll('.btn-delete-holding').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      state.holdings = state.holdings.filter(h => h.id !== id);
      saveHoldings();
      renderPortfolio(); // 두 뷰 모두 갱신
    });
  });
}

function renderPortfolio() {
  // 종합 대시보드의 포트폴리오만 렌더링
  renderPortfolioToTarget('holdingsTableBody', 'totalAssetValue', 'totalAssetValueKRW', 'totalProfitLoss', 'totalProfitLossKRW');
}

function saveHoldings() {
  localStorage.setItem('stock_app_holdings', JSON.stringify(state.holdings));
}

function saveWatchlist(shouldSync = true) {
  localStorage.setItem('stock_app_watchlist', JSON.stringify(state.watchlist.map(({ marketData, ...settings }) => settings)));
  if (shouldSync) void uploadWatchlistToCloudflare();
}

/** 저장된 금융 숫자만 형식화한다. null은 0으로 보정하지 않는다. */
function hasStoredNumber(value) {
  return toNullableNumber(value) !== null;
}

function formatUsdValue(value) {
  const number = toNullableNumber(value);
  return number === null ? '데이터 없음' : `$${number.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPercent(value) {
  const number = toNullableNumber(value);
  return number === null ? '—' : `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
}

function getChangeDirectionClass(value) {
  const number = toNullableNumber(value);
  if (number === null) return 'unknown';
  return number >= 0 ? 'up' : 'down';
}

function formatPriceChange(change, changePercent) {
  const amount = toNullableNumber(change);
  const percent = toNullableNumber(changePercent);
  if (amount === null && percent === null) return '변동 데이터 없음';
  const amountText = amount === null
    ? '변동액 없음'
    : `${amount >= 0 ? '+' : '-'}${formatUsdValue(Math.abs(amount))}`;
  return `${amountText} ${percent === null ? '(변동률 없음)' : `(${formatPercent(percent)})`}`;
}

function formatMonthDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return '미정';
  const [, month, day] = value.match(/^\d{4}-(\d{2})-(\d{2})/) || [];
  return month && day ? `${Number(month)}/${Number(day)}` : '미정';
}

function escapeHtml(value) {
  const characters = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, character => characters[character]);
}

// 화폐 포맷팅 함수 ($ 또는 ₩). 환율이 저장되지 않았을 때는 가상 환산값을 표시하지 않는다.
function formatCurrency(valUSD) {
  const number = toNullableNumber(valUSD);
  if (number === null) return '데이터 없음';
  if (state.isKrwView) {
    if (!hasStoredNumber(state.usdKrwRate)) return '환율 데이터 없음';
    const krw = Math.round(number * state.usdKrwRate);
    return `₩${krw.toLocaleString()}`;
  }
  return formatUsdValue(number);
}

// ========================================================
// 🪟 7. 모달 및 백업 처리
// ========================================================
function setupModals() {
  // 모달 닫기 버튼들
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-close');
      closeModal(modalId);
    });
  });

  document.getElementById('confirmAddStockBtn').addEventListener('click', () => {
    const ticker = document.getElementById('stockTickerInput').value.trim().toUpperCase();
    const strategy = document.getElementById('stockStrategyInput').value;
    if (addNewStock(ticker, strategy)) {
      closeModal('addStockModal');
      document.getElementById('stockTickerInput').value = '';
      document.getElementById('stockStrategyInput').value = 'price';
    }
  });

  document.getElementById('confirmAddHoldingBtn').addEventListener('click', () => {
    const ticker = document.getElementById('holdingTickerInput').value.trim().toUpperCase();
    const qty = parseFloat(document.getElementById('holdingQtyInput').value);
    const buyPrice = parseFloat(document.getElementById('holdingBuyPriceInput').value);

    if (ticker && !isNaN(qty) && !isNaN(buyPrice) && qty > 0 && buyPrice > 0) {
      state.holdings.push({
        id: Date.now().toString(),
        ticker,
        qty,
        buyPrice
      });
      saveHoldings();
      renderPortfolio();
      closeModal('addHoldingModal');
      document.getElementById('holdingTickerInput').value = '';
      document.getElementById('holdingQtyInput').value = '';
      document.getElementById('holdingBuyPriceInput').value = '';
    }
  });

  // 헤더의 백업 버튼은 5번 설정 화면으로 이동합니다.
  document.getElementById('backupModalBtn').addEventListener('click', () => {
    showDashboardView('settings');
  });

  // PIN 변경
  document.getElementById('saveNewPinBtn').addEventListener('click', () => {
    const newPin = document.getElementById('newPinInput').value.trim();
    if (newPin.length === 4 && /^\d+$/.test(newPin)) {
      state.currentPin = newPin;
      localStorage.setItem('stock_app_pin', newPin);
      alert('보안 PIN 번호가 성공적으로 변경되었습니다!');
      document.getElementById('newPinInput').value = '';
    } else {
      alert('PIN 번호는 4자리 숫자여야 합니다.');
    }
  });

  // JSON 백업 다운로드
  document.getElementById('exportDataBtn').addEventListener('click', () => {
    const backupData = {
      watchlist: state.watchlist,
      holdings: state.holdings,
      exportDate: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stock_dashboard_backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // JSON 백업 복원
  document.getElementById('importDataInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const imported = JSON.parse(event.target.result);
          if (imported.watchlist && imported.holdings) {
            state.watchlist = imported.watchlist;
            state.holdings = imported.holdings;
            saveWatchlist();
            saveHoldings();
            renderWatchlist();
            renderPortfolio();
            alert('데이터가 성공적으로 복원되었습니다!');
          } else {
            alert('올바른 백업 파일 형식이 아닙니다.');
          }
        } catch (err) {
          alert('파일을 읽는 도중 오류가 발생했습니다.');
        }
      };
      reader.readAsText(file);
    }
  });

  // 원화/달러 토글
  document.getElementById('currencyToggleBtn').addEventListener('click', () => {
    state.isKrwView = !state.isKrwView;
    renderWatchlist();
    renderPortfolio();
    loadStockChart(state.selectedTicker);
  });
}

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// ========================================================
// 🧭 8. 메인메뉴: 선택한 메뉴에 맞는 독립 메인화면 표시
// ========================================================
function showDashboardView(viewName) {
  const dashboard = document.getElementById('view-overview');
  const sectionByView = {
    overview: 'section-overview',
    chart: 'section-chart',
    portfolio: 'section-portfolio',
    watchlist: 'section-watchlist',
    settings: 'section-settings'
  };

  if (!dashboard || !sectionByView[viewName]) return;

  // 메뉴당 하나의 독립 화면만 표시합니다.
  Object.values(sectionByView).forEach(sectionId => {
    const section = document.getElementById(sectionId);
    const shouldShow = sectionId === sectionByView[viewName];
    if (section) section.classList.toggle('section-hidden', !shouldShow);
  });
  dashboard.classList.add('single-view');

  document.querySelectorAll('#mainMenuNav .main-menu-btn').forEach(button => {
    button.classList.toggle('active', button.getAttribute('data-view') === viewName);
  });

  state.currentView = viewName;
  // 메뉴 2를 볼 때만 위젯을 만들고 다른 메뉴로 이동하면 iframe을 해제한다.
  if (viewName === 'chart') {
    const stock = getSelectedStock();
    requestAnimationFrame(() => renderActiveTradingViewChart(stock));
    // 2번 차트를 처음 열 때만 선택 종목의 OHLC·상세 원본을 읽는다.
    if (stock) void loadStockChart(stock.ticker);
  } else {
    destroyMainChart();
  }
  // 무거운 저장 현황은 5번을 볼 때만 요청한다. 잠금 해제 직후의 네트워크 경합을 없앤다.
  if (viewName === 'settings') window.FundamentalProgress?.start();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setupMainMenuNav() {
  const menuBtns = document.querySelectorAll('#mainMenuNav .main-menu-btn');

  menuBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-view');
      showDashboardView(view);
    });
  });

  // 종합 페이지의 '상세 모달' 버튼들 이벤트 바인딩 (open-add-stock-btn)
  document.querySelectorAll('.open-add-stock-btn').forEach(btn => {
    btn.addEventListener('click', () => openModal('addStockModal'));
  });

  // 종합 페이지의 '매수 기록 추가' 버튼들 이벤트 바인딩 (open-add-holding-btn)
  document.querySelectorAll('.open-add-holding-btn').forEach(btn => {
    btn.addEventListener('click', () => openModal('addHoldingModal'));
  });
}

/**
 * 회사 상세 화면의 탭과 돌아가기 동작을 한곳에서 관리합니다.
 * API 연결 뒤에도 탭 전환 구조는 유지하고 각 패널의 내용만 실제 데이터로 교체합니다.
 */
function setupCompanyDetail() {
  document.getElementById('closeCompanyDetailBtn').addEventListener('click', () => {
    closeCompanyDetailModal();
  });

  const modal = document.getElementById('companyDetailModal');
  modal.addEventListener('click', event => {
    // 카드 바깥 배경을 클릭한 경우에만 닫아 내부 탭 조작은 유지합니다.
    if (event.target === modal) closeCompanyDetailModal();
  });

  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeCompanyDetailModal();
    }
  });

  document.querySelectorAll('.company-detail-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const selectedTab = tab.getAttribute('data-detail-tab');
      document.querySelectorAll('.company-detail-tab').forEach(button => {
        button.classList.toggle('active', button === tab);
      });
      document.querySelectorAll('.company-detail-panel').forEach(panel => {
        panel.classList.toggle('hidden', panel.getAttribute('data-detail-panel') !== selectedTab);
      });
      if (selectedTab === 'chart') {
        requestAnimationFrame(() => renderActiveTradingViewChart());
      } else {
        destroyDetailChart();
      }
    });
  });
}

function openCompanyDetailModal() {
  updateCompanySummary();
  document.getElementById('companyDetailModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
  // 뒤쪽 2번 위젯을 제거해 상세창에 외부 iframe 하나만 유지한다.
  destroyMainChart();
  requestAnimationFrame(() => {
    renderActiveTradingViewChart();
  });
  // 상세창에 저장값을 먼저 보여준 뒤, 누락 데이터가 있으면 Worker가 SEC 대체 경로로 즉시 보완한다.
  if (state.selectedTicker) void synchronizeStockDataWithCloudflare(state.selectedTicker);
}

function closeCompanyDetailModal() {
  document.getElementById('companyDetailModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
  // 닫힌 모달의 iframe을 해제하고, 현재 화면이 2번일 때만 메인 차트를 복원한다.
  destroyDetailChart();
  requestAnimationFrame(() => {
    if (state.currentView === 'chart' && !mainApp.classList.contains('hidden')) initChart();
  });
}

// ========================================================
// 🚀 9. 대시보드 초기화
// ========================================================
function initDashboard() {
  initChart();
  // 잠금 해제 후 다시 진입해도 이벤트가 중복 등록되지 않게 한 번만 연결합니다.
  if (!state.dashboardEventsBound) {
    setupOverviewQuickAdd();
    setupCompanyDetail();
    setupTradingViewControls();
    state.dashboardEventsBound = true;
  }
  renderWatchlist();
  renderPortfolio();
  showDashboardView('overview');
  void synchronizeWatchlistWithCloudflare();
}

// DOM 준비 완료 시 구동
document.addEventListener('DOMContentLoaded', () => {
  setupPinKeypad();
  setupMainMenuNav();
  setupModals();
});
