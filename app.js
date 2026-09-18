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

function validatePin() {
  if (state.enteredPin === state.currentPin) {
    unlockApp();
  } else {
    pinError.textContent = '잘못된 PIN 번호입니다. 다시 입력해 주세요.';
    state.enteredPin = '';
    updatePinDots();
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
// 📋 5. 관심종목 렌더링 & 관리
// ========================================================
function renderWatchlist() {
  const container = document.getElementById('watchlistContainer');
  container.innerHTML = '';

  state.watchlist.forEach(stock => {
    const isUp = stock.change >= 0;
    const item = document.createElement('div');
    item.className = `stock-item ${stock.ticker === state.selectedTicker ? 'active' : ''}`;
    item.innerHTML = `
      <div class="stock-item-left">
        <span class="stock-item-ticker">${stock.ticker}</span>
        <span class="stock-item-name">${stock.name}</span>
      </div>
      <div class="stock-item-right">
        <div class="stock-item-price">${formatCurrency(stock.price)}</div>
        <div class="stock-item-change ${isUp ? 'up' : 'down'}">
          ${isUp ? '+' : ''}${stock.changePct.toFixed(2)}%
        </div>
      </div>
    `;

    item.addEventListener('click', () => {
      state.selectedTicker = stock.ticker;
      renderWatchlist();
      loadStockChart(stock.ticker);
      
      // 모바일일 경우 차트 탭으로 자동 이동
      if (window.innerWidth <= 768) {
        switchMobileTab('chart');
      }
    });

    container.appendChild(item);
  });
}

// ========================================================
// 💼 6. 내 포트폴리오 렌더링 & 손익 계산
// ========================================================
function renderPortfolio() {
  const tbody = document.getElementById('holdingsTableBody');
  tbody.innerHTML = '';

  let totalBuyAmount = 0;
  let totalCurrentAmount = 0;

  state.holdings.forEach(holding => {
    // 현재가 매칭 (관심종목에 없으면 기본값)
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

  document.getElementById('totalAssetValue').textContent = formatCurrency(totalCurrentAmount);
  document.getElementById('totalAssetValueKRW').textContent = `≈ ${Math.round(totalCurrentAmount * state.usdKrwRate).toLocaleString()}원`;

  const pnlElem = document.getElementById('totalProfitLoss');
  pnlElem.className = `value ${isTotalUp ? 'up' : 'down'}`;
  pnlElem.textContent = `${isTotalUp ? '+' : ''}$${totalPnl.toFixed(2)} (${isTotalUp ? '+' : ''}${totalPnlPct.toFixed(2)}%)`;
  
  document.getElementById('totalProfitLossKRW').textContent = `≈ ${isTotalUp ? '+' : ''}${Math.round(totalPnl * state.usdKrwRate).toLocaleString()}원`;

  // 삭제 버튼 이벤트
  tbody.querySelectorAll('.btn-delete-holding').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      state.holdings = state.holdings.filter(h => h.id !== id);
      saveHoldings();
      renderPortfolio();
    });
  });
}

function saveHoldings() {
  localStorage.setItem('stock_app_holdings', JSON.stringify(state.holdings));
}

function saveWatchlist() {
  localStorage.setItem('stock_app_watchlist', JSON.stringify(state.watchlist));
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
// 📱 7. 모바일 탭 네비게이션
// ========================================================
function setupMobileNav() {
  const navItems = document.querySelectorAll('.mobile-nav .nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.getAttribute('data-tab');
      if (tab === 'settings') {
        openModal('backupModal');
      } else {
        switchMobileTab(tab);
      }
    });
  });
}

function switchMobileTab(tab) {
  document.querySelectorAll('.mobile-nav .nav-item').forEach(i => {
    i.classList.toggle('active', i.getAttribute('data-tab') === tab);
  });

  const sections = {
    watchlist: document.getElementById('watchlistTabSection'),
    chart: document.getElementById('chartTabSection'),
    portfolio: document.getElementById('portfolioTabSection')
  };

  Object.keys(sections).forEach(k => {
    if (sections[k]) {
      sections[k].classList.toggle('mobile-active', k === tab);
    }
  });

  // 차트 탭으로 전환 시 차트 크기 재조정
  if (tab === 'chart' && tvChart) {
    setTimeout(() => {
      tvChart.applyOptions({
        width: tvChartContainer.clientWidth,
        height: tvChartContainer.clientHeight
      });
      tvChart.timeScale().fitContent();
    }, 100);
  }
}

// ========================================================
// 🪟 8. 모달 및 백업 처리
// ========================================================
function setupModals() {
  // 모달 닫기 버튼들
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-close');
      closeModal(modalId);
    });
  });

  // 관심종목 추가 모달 열기
  document.getElementById('openAddStockModalBtn').addEventListener('click', () => {
    openModal('addStockModal');
  });

  document.getElementById('confirmAddStockBtn').addEventListener('click', () => {
    const ticker = document.getElementById('stockTickerInput').value.trim().toUpperCase();
    const name = document.getElementById('stockNameInput').value.trim() || ticker;
    if (ticker) {
      if (!state.watchlist.some(s => s.ticker === ticker)) {
        state.watchlist.push({
          ticker,
          name,
          price: 100.00 + Math.random() * 150,
          change: (Math.random() - 0.4) * 5,
          changePct: (Math.random() - 0.4) * 3
        });
        saveWatchlist();
        renderWatchlist();
      }
      closeModal('addStockModal');
      document.getElementById('stockTickerInput').value = '';
      document.getElementById('stockNameInput').value = '';
    }
  });

  // 매수 기록 추가 모달 열기
  document.getElementById('openAddHoldingModalBtn').addEventListener('click', () => {
    openModal('addHoldingModal');
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

  // 백업 및 PIN 설정 모달
  document.getElementById('backupModalBtn').addEventListener('click', () => {
    openModal('backupModal');
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
            closeModal('backupModal');
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
// 🚀 9. 대시보드 초기화
// ========================================================
function initDashboard() {
  initChart();
  renderWatchlist();
  renderPortfolio();

  // 모바일 초기 탭 설정
  if (window.innerWidth <= 768) {
    switchMobileTab('chart');
  }
}

// DOM 준비 완료 시 구동
document.addEventListener('DOMContentLoaded', () => {
  setupPinKeypad();
  setupMobileNav();
  setupModals();
});
