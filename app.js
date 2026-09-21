// ========================================================
// US Stock Pro - 대시보드 코어 로직 & 차트 엔드포인트
// ========================================================

// 1. 상태(State) 관리
const state = {
  currentPin: (localStorage.getItem('stock_app_pin') === '1234' ? '5260' : (localStorage.getItem('stock_app_pin') || '5260')),
  enteredPin: '',
  usdKrwRate: 1342.50,
  isKrwView: false,
  selectedTicker: 'NVDA',
  activePeriod: '1D',
  dashboardEventsBound: false,
  // Worker 인증이 성공한 현재 PIN만 메모리에 보관한다. 새로고침 뒤에는 다시 PIN을 입력해야 한다.
  apiPin: '',
  watchlistSyncStarted: false,
  
  // 기본 관심종목
  watchlist: JSON.parse(localStorage.getItem('stock_app_watchlist')) || [
    { ticker: 'NVDA', name: 'NVIDIA Corporation', price: 124.58, change: 4.25, changePct: 3.53 },
    { ticker: 'AAPL', name: 'Apple Inc.', price: 228.20, change: 1.15, changePct: 0.51 },
    { ticker: 'TSLA', name: 'Tesla, Inc.', price: 243.90, change: -3.80, changePct: -1.53 },
    { ticker: 'MSFT', name: 'Microsoft Corp.', price: 432.10, change: 2.40, changePct: 0.56 },
    { ticker: 'AMZN', name: 'Amazon.com Inc.', price: 186.40, change: -0.90, changePct: -0.48 }
  ],

  // 내 보유 포트폴리오
  holdings: JSON.parse(localStorage.getItem('stock_app_holdings')) || [
    { id: '1', ticker: 'NVDA', qty: 25, buyPrice: 112.50 },
    { id: '2', ticker: 'AAPL', qty: 15, buyPrice: 215.00 },
    { id: '3', ticker: 'TSLA', qty: 10, buyPrice: 230.00 }
  ]
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
    strategy: stock.strategy === 'dividend' ? 'dividend' : 'price',
    price: Number.isFinite(Number(stock.price)) ? Number(stock.price) : 0,
    change: Number.isFinite(Number(stock.change)) ? Number(stock.change) : 0,
    changePct: Number.isFinite(Number(stock.changePct)) ? Number(stock.changePct) : 0
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
  const apiUrl = getCloudflareApiUrl('/api/watchlist');
  if (!apiUrl || !state.apiPin || state.watchlistSyncStarted) return;
  state.watchlistSyncStarted = true;

  try {
    const response = await fetch(apiUrl, getCloudflareRequestOptions());
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { watchlist } = await response.json();

    if (Array.isArray(watchlist) && watchlist.length > 0) {
      // D1에 이미 저장된 목록이 있으면 그것이 모든 기기의 기준 데이터다.
      state.watchlist = normalizeRemoteWatchlist(watchlist);
      state.selectedTicker = state.watchlist[0]?.ticker || null;
      saveWatchlist(false);
      renderWatchlist();
      renderPortfolio();
      if (state.selectedTicker) loadStockChart(state.selectedTicker);
    } else if (state.watchlist.length > 0) {
      // 첫 동기화만 현재 브라우저의 기존 목록을 D1로 옮긴다.
      await uploadWatchlistToCloudflare();
    }
  } catch (error) {
    console.warn('Cloudflare 관심종목 동기화에 실패했습니다.', error);
  }
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

    // API 값이 있을 때만 덮어써, 동기화 전 화면의 사용자 데이터가 사라지지 않게 한다.
    stock.name = company.name || stock.name;
    stock.sector = company.sector || stock.sector;
    stock.price = Number.isFinite(company.currentPrice) ? company.currentPrice : stock.price;
    stock.change = Number.isFinite(company.changeAmount) ? company.changeAmount : stock.change;
    stock.changePct = Number.isFinite(company.changePercent) ? company.changePercent : stock.changePct;
    saveWatchlist();
    renderWatchlist();
  } catch (error) {
    // 네트워크 실패는 화면 사용을 막지 않는다. 다음 동기화 또는 새로고침에서 다시 시도한다.
    console.warn('Cloudflare 회사 프로필을 불러오지 못했습니다.', error);
  }
}

// 2. DOM 요소 캐싱
const pinScreen = document.getElementById('pinScreen');
const mainApp = document.getElementById('mainApp');
const pinDots = document.querySelectorAll('.pin-dots .dot');
const pinError = document.getElementById('pinError');
const tvChartContainer = document.getElementById('tvChartContainer');

let tvChart = null;
let candleSeries = null;
let volumeSeries = null;
let ma20Series = null;
let ma60Series = null;

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
  mainApp.classList.add('hidden');
  pinScreen.classList.remove('hidden');
  state.enteredPin = '';
  // 잠금 후에는 메모리에만 있던 Worker PIN도 제거한다.
  state.apiPin = '';
  state.watchlistSyncStarted = false;
  updatePinDots();
}

// ========================================================
// 📊 4. TradingView 인터랙티브 캔들 차트
// ========================================================
function initChart() {
  if (tvChart) {
    tvChart.remove();
  }

  tvChartContainer.innerHTML = '';

  tvChart = LightweightCharts.createChart(tvChartContainer, {
    layout: {
      background: { color: 'transparent' },
      textColor: '#94a3b8',
      fontSize: 12,
      fontFamily: 'Inter, sans-serif'
    },
    grid: {
      vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
      horzLines: { color: 'rgba(255, 255, 255, 0.04)' }
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
    },
    rightPriceScale: {
      borderColor: 'rgba(255, 255, 255, 0.08)',
    },
    timeScale: {
      borderColor: 'rgba(255, 255, 255, 0.08)',
      timeVisible: true,
      secondsVisible: false,
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
  });

  // 캔들 시리즈 추가
  candleSeries = tvChart.addCandlestickSeries({
    upColor: '#10b981',
    downColor: '#f43f5e',
    borderUpColor: '#10b981',
    borderDownColor: '#f43f5e',
    wickUpColor: '#10b981',
    wickDownColor: '#f43f5e',
  });

  // 볼륨(거래량) 시리즈 추가
  volumeSeries = tvChart.addHistogramSeries({
    color: 'rgba(56, 189, 248, 0.3)',
    priceFormat: { type: 'volume' },
    priceScaleId: '', // 메인 차트 오버레이
    scaleMargins: { top: 0.82, bottom: 0 },
  });

  // MA20 & MA60 이동평균선
  ma20Series = tvChart.addLineSeries({
    color: '#facc15',
    lineWidth: 1.5,
    title: 'MA20'
  });

  ma60Series = tvChart.addLineSeries({
    color: '#a855f7',
    lineWidth: 1.5,
    title: 'MA60'
  });

  // 크로스헤어 호버 시 OHLCV 업데이트
  tvChart.subscribeCrosshairMove(param => {
    if (!param || !param.time || !param.seriesData) {
      return;
    }
    const candle = param.seriesData.get(candleSeries);
    const volume = param.seriesData.get(volumeSeries);
    if (candle) {
      document.getElementById('ohlcOpen').textContent = `$${candle.open.toFixed(2)}`;
      document.getElementById('ohlcHigh').textContent = `$${candle.high.toFixed(2)}`;
      document.getElementById('ohlcLow').textContent = `$${candle.low.toFixed(2)}`;
      document.getElementById('ohlcClose').textContent = `$${candle.close.toFixed(2)}`;
    }
    if (volume) {
      document.getElementById('ohlcVol').textContent = Number(volume.value).toLocaleString();
    }
  });

  // 리사이즈 옵저버
  window.addEventListener('resize', () => {
    if (tvChart && tvChartContainer) {
      tvChart.applyOptions({
        width: tvChartContainer.clientWidth,
        height: tvChartContainer.clientHeight
      });
    }
  });

  loadStockChart(state.selectedTicker);
}

// 모의 주가 캔들 및 이평선 데이터 생성
function generateHistoricalData(basePrice, days = 160) {
  const data = [];
  const volumes = [];
  let price = basePrice * 0.75;
  const now = new Date();
  
  for (let i = days; i >= 0; i--) {
    const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    // 주말 제외
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    
    const timeStr = date.toISOString().split('T')[0];
    const change = (Math.random() - 0.48) * (price * 0.04);
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random() * (price * 0.02);
    const low = Math.min(open, close) - Math.random() * (price * 0.02);
    const volume = Math.floor(Math.random() * 8000000) + 1500000;
    
    price = close;
    data.push({ time: timeStr, open, high, low, close });
    volumes.push({
      time: timeStr,
      value: volume,
      color: close >= open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(244, 63, 94, 0.35)'
    });
  }

  // MA 계산
  const ma20 = [];
  const ma60 = [];
  for (let i = 0; i < data.length; i++) {
    if (i >= 19) {
      const sum20 = data.slice(i - 19, i + 1).reduce((acc, c) => acc + c.close, 0);
      ma20.push({ time: data[i].time, value: sum20 / 20 });
    }
    if (i >= 59) {
      const sum60 = data.slice(i - 59, i + 1).reduce((acc, c) => acc + c.close, 0);
      ma60.push({ time: data[i].time, value: sum60 / 60 });
    }
  }

  return { candles: data, volumes, ma20, ma60 };
}

function loadStockChart(ticker) {
  const stock = state.watchlist.find(s => s.ticker === ticker) || {
    ticker,
    name: ticker,
    price: 150.00,
    change: 2.5,
    changePct: 1.5
  };

  document.getElementById('chartTicker').textContent = stock.ticker;
  document.getElementById('chartCompanyName').textContent = stock.name;
  document.getElementById('chartPrice').textContent = formatCurrency(stock.price);
  
  const changeElem = document.getElementById('chartChange');
  const isUp = stock.change >= 0;
  changeElem.className = `price-change ${isUp ? 'up' : 'down'}`;
  changeElem.textContent = `${isUp ? '+' : ''}${stock.change.toFixed(2)} (${isUp ? '+' : ''}${stock.changePct.toFixed(2)}%)`;

  const history = generateHistoricalData(stock.price, 180);
  candleSeries.setData(history.candles);
  volumeSeries.setData(history.volumes);
  ma20Series.setData(history.ma20);
  ma60Series.setData(history.ma60);
  tvChart.timeScale().fitContent();
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

  // 신규 종목 시세 생성 및 등록 (자동 정렬하지 않고 사용자가 추가한 순서 그대로 배열에 추가)
  const profile = getLocalCompanyProfile(ticker);
  const newStock = {
    ticker,
    // API 연동 전에는 제한된 로컬 사전 정보만 사용하고, 그 외 종목은 자동 조회 대기로 둡니다.
    name: profile.name,
    sector: profile.sector,
    strategy,
    price: 100.00 + Math.random() * 150,
    change: (Math.random() - 0.4) * 6,
    changePct: (Math.random() - 0.4) * 3.5
  };

  state.watchlist.push(newStock);
  saveWatchlist();
  renderWatchlist();
  void updateStockProfileFromCloudflare(ticker);

  // 첫 번째 종목이거나 현재 선택된 차트가 없으면 즉시 해당 종목 차트 로드
  if (!state.selectedTicker || state.watchlist.length === 1) {
    state.selectedTicker = ticker;
    loadStockChart(ticker);
  }

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

/**
 * 1번 종합의 회사 목록과 요약 정보를 동기화합니다.
 * 재무·배당 값은 API 연결 전임을 명확히 표시해 예시 데이터를 실제 정보로 오해하지 않게 합니다.
 */
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
    .sort((first, second) => getExampleWilliamsR(first.ticker) - getExampleWilliamsR(second.ticker))
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
    const williams = getExampleWilliamsR(stock.ticker);
    const signal = getWilliamsSignal(williams);
    const dividend = getExampleDividendInfo(stock.ticker);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `overview-stock-row ${shouldShowDividendDetails ? '' : 'price-stock-row'} ${stock.ticker === state.selectedTicker ? 'active' : ''}`;
    item.innerHTML = `
      <span class="overview-company-cell"><strong>${stock.ticker}</strong><span title="${stock.name}">${stock.name}</span></span>
      <span class="overview-price-cell"><strong>${formatCurrency(stock.price)}</strong><span class="${stock.change >= 0 ? 'up' : 'down'}">${stock.change >= 0 ? '+' : ''}${stock.changePct.toFixed(2)}%</span></span>
      <svg class="overview-sparkline" viewBox="0 0 110 35" aria-label="${stock.ticker} 예시 주가 추이"><polyline points="${createExampleSparkline(stock.ticker)}"></polyline></svg>
      <span class="overview-williams-cell"><span class="overview-williams-value">${williams.toFixed(1)}</span><span class="overview-value-label">Williams %R (14일)</span></span>
      <span class="overview-signal-cell"><span class="overview-signal ${signal.className}">${signal.label}</span><span class="overview-value-label">투자 신호 · 예시</span></span>
      ${shouldShowDividendDetails ? `
        <span class="overview-next-dividend-cell ${dividend.status}"><strong>${dividend.nextDate}</strong><span>${dividend.statusLabel}</span></span>
        <span class="overview-dividend-day-cell ${dividend.status}"><strong>${dividend.daysLeft}</strong><span>미국 영업일 기준</span></span>
        <span class="overview-dividend-cell"><strong>${dividend.yieldRate}</strong><span>배당수익률 · 예시</span></span>
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

/** API 연동 전 목록 UI를 검증하기 위한 종목별 고정 예시 Williams %R 값입니다. */
function getExampleWilliamsR(ticker) {
  const seed = ticker.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return -((seed * 13) % 86 + 8);
}

/** 실제 매수·매도 기준은 나중에 사용자 전략 설정과 API 데이터로 교체합니다. */
function getWilliamsSignal(williamsR) {
  if (williamsR <= -80) return { label: '매수 검토', className: 'buy' };
  if (williamsR >= -20) return { label: '매도 검토', className: 'sell' };
  return { label: '관찰', className: 'hold' };
}

/** 외부 배당 API가 연결되기 전까지 레이아웃 확인용으로만 쓰는 고정 예시입니다. */
function getExampleDividendInfo(ticker) {
  const seed = ticker.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const days = (seed % 75) + 7;
  return {
    yieldRate: `${((seed % 55) / 10 + 0.4).toFixed(2)}%`,
    nextDate: '11/20 예시',
    daysLeft: `D-${days}`,
    // 실제 API 응답의 확정 여부에 따라 confirmed(녹색) 또는 estimated(주황색)를 사용합니다.
    status: seed % 2 === 0 ? 'confirmed' : 'estimated',
    statusLabel: seed % 2 === 0 ? '확정일 · 예시' : '예정일 · 예시'
  };
}

/**
 * 미국 거래소 휴장일 목록을 받아 다음 배당일까지의 영업일 수를 계산합니다.
 * 주말만 제외하면 미국 공휴일·임시 휴장을 놓치므로, 실제 API 연동 시에는 거래소 캘린더 값을 반드시 전달해야 합니다.
 */
function calculateUsTradingDays(fromDate, targetDate, marketClosedDates = []) {
  const start = new Date(fromDate);
  const end = new Date(targetDate);
  const closedDates = new Set(marketClosedDates);
  let businessDays = 0;

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;

  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  while (cursor <= end) {
    const day = cursor.getDay();
    const dateKey = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    if (day !== 0 && day !== 6 && !closedDates.has(dateKey)) businessDays += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return businessDays;
}

/** 티커별로 항상 같은 모양을 만드는 예시 스파크라인입니다. */
function createExampleSparkline(ticker) {
  const seed = ticker.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const points = [];
  for (let index = 0; index < 14; index += 1) {
    const value = 18 + ((seed * (index + 3) + index * index * 9) % 17);
    points.push(`${index * 8.45},${35 - value}`);
  }
  return points.join(' ');
}

function updateCompanySummary() {
  const stock = state.watchlist.find(item => item.ticker === state.selectedTicker) || state.watchlist[0];
  if (!stock) return;

  const isUp = stock.change >= 0;
  const changeText = `${isUp ? '+' : ''}${stock.change.toFixed(2)} (${isUp ? '+' : ''}${stock.changePct.toFixed(2)}%)`;
  const summaryFields = {
    overviewTicker: stock.ticker,
    overviewCompanyName: stock.name,
    overviewPrice: formatCurrency(stock.price),
    overviewChange: changeText,
    detailTicker: stock.ticker,
    detailCompanyName: stock.name,
    detailPrice: formatCurrency(stock.price),
    detailChange: `${isUp ? '+' : ''}${stock.changePct.toFixed(2)}%`
  };

  Object.entries(summaryFields).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });
  ['overviewChange', 'detailChange'].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.className = isUp ? 'up' : 'down';
  });

  const williams = getExampleWilliamsR(stock.ticker);
  const signal = getWilliamsSignal(williams);
  const detailFields = {
    detailWilliamsR: `예시 ${williams.toFixed(1)}`,
    detailWilliamsSignal: `예시 ${williams <= -80 ? '과매도 구간' : williams >= -20 ? '과매수 구간' : '중립 구간'}`,
    detailInvestmentSignal: `예시 ${signal.label}`
  };
  Object.entries(detailFields).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });
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
    const isUp = stock.change >= 0;
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
        <span class="stock-item-ticker">${stock.ticker}</span>
        <span class="stock-item-name">${stock.name}</span>
        <span class="stock-item-meta"><span class="strategy-badge ${strategy}">${strategy === 'dividend' ? '배당 투자' : '주가 투자'}</span>${getStockSector(stock)}</span>
      </div>
      <div class="stock-item-right">
        <div class="stock-item-price">${formatCurrency(stock.price)}</div>
        <div class="stock-item-change ${isUp ? 'up' : 'down'}">
          ${isUp ? '+' : ''}${stock.changePct.toFixed(2)}%
        </div>
      </div>
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

  state.holdings.forEach(holding => {
    const stock = state.watchlist.find(s => s.ticker === holding.ticker);
    const currentPrice = stock ? stock.price : holding.buyPrice * 1.05;

    const buyVal = holding.qty * holding.buyPrice;
    const curVal = holding.qty * currentPrice;
    const pnl = curVal - buyVal;
    const pnlPct = (pnl / buyVal) * 100;
    const isUp = pnl >= 0;

    totalBuyAmount += buyVal;
    totalCurrentAmount += curVal;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${holding.ticker}</strong></td>
      <td>${holding.qty}주</td>
      <td>$${holding.buyPrice.toFixed(2)}</td>
      <td>$${currentPrice.toFixed(2)}</td>
      <td class="${isUp ? 'up' : 'down'}">
        <strong>${isUp ? '+' : ''}$${pnl.toFixed(2)}</strong><br>
        <small>(${isUp ? '+' : ''}${pnlPct.toFixed(2)}%)</small>
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
  const totalPnl = totalCurrentAmount - totalBuyAmount;
  const totalPnlPct = totalBuyAmount > 0 ? (totalPnl / totalBuyAmount) * 100 : 0;
  const isTotalUp = totalPnl >= 0;

  const valElem = document.getElementById(totalValId);
  const valKrwElem = document.getElementById(totalValKrwId);
  const pnlElem = document.getElementById(totalPnlId);
  const pnlKrwElem = document.getElementById(totalPnlKrwId);

  if (valElem) valElem.textContent = formatCurrency(totalCurrentAmount);
  if (valKrwElem) valKrwElem.textContent = `≈ ${Math.round(totalCurrentAmount * state.usdKrwRate).toLocaleString()}원`;
  if (pnlElem) {
    pnlElem.className = `value ${isTotalUp ? 'up' : 'down'}`;
    pnlElem.textContent = `${isTotalUp ? '+' : ''}$${totalPnl.toFixed(2)} (${isTotalUp ? '+' : ''}${totalPnlPct.toFixed(2)}%)`;
  }
  if (pnlKrwElem) pnlKrwElem.textContent = `≈ ${isTotalUp ? '+' : ''}${Math.round(totalPnl * state.usdKrwRate).toLocaleString()}원`;

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
  localStorage.setItem('stock_app_watchlist', JSON.stringify(state.watchlist));
  if (shouldSync) void uploadWatchlistToCloudflare();
}

// 화폐 포맷팅 함수 ($ 또는 ₩)
function formatCurrency(valUSD) {
  if (state.isKrwView) {
    const krw = Math.round(valUSD * state.usdKrwRate);
    return `₩${krw.toLocaleString()}`;
  }
  return `$${valUSD.toFixed(2)}`;
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

  // 숨겨진 상태에서 차트를 열면 너비가 0이 될 수 있어 표시 후 다시 계산합니다.
  if (viewName === 'chart' && tvChart) {
    setTimeout(() => {
      tvChart.applyOptions({
        width: tvChartContainer.clientWidth,
        height: tvChartContainer.clientHeight
      });
      tvChart.timeScale().fitContent();
    }, 0);
  }

  state.currentView = viewName;
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
    });
  });
}

function openCompanyDetailModal() {
  updateCompanySummary();
  document.getElementById('companyDetailModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeCompanyDetailModal() {
  document.getElementById('companyDetailModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
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
