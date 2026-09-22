// ========================================================
// TradingView Advanced Chart 위젯 공통 모듈
// ========================================================

(function initializeTradingViewWidgetModule() {
  const EMBED_WIDGET_URL = 'https://www.tradingview-widget.com/embed-widget/advanced-chart/';

  /**
   * FMP가 반환하는 거래소 표기를 TradingView 심볼 접두사로 변환한다.
   * 거래소가 아직 수집되지 않은 신규 종목은 티커만 전달해 위젯의 자동 검색을 사용한다.
   */
  function normalizeExchange(exchange) {
    const normalized = String(exchange || '').trim().toUpperCase().replaceAll(' ', '');
    if (normalized.includes('NASDAQ')) return 'NASDAQ';
    if (normalized.includes('NYSEAMERICAN') || normalized.includes('AMEX') || normalized.includes('ARCA')) return 'AMEX';
    if (normalized.includes('NYSE') || normalized.includes('NEWYORKSTOCKEXCHANGE')) return 'NYSE';
    if (normalized.includes('OTC')) return 'OTC';
    return '';
  }

  function sanitizeTicker(ticker) {
    return String(ticker || '').trim().toUpperCase().replace(/[^A-Z0-9._-]/g, '');
  }

  function buildSymbol(ticker, exchange) {
    const safeTicker = sanitizeTicker(ticker);
    const safeExchange = normalizeExchange(exchange);
    return safeExchange ? `${safeExchange}:${safeTicker}` : safeTicker;
  }

  const DEFAULT_CHART_SETTINGS = Object.freeze({
    interval: 'D',
    range: '3M'
  });

  const ALLOWED_INTERVALS = new Set(['1', '5', '15', '60', 'D', 'W', 'M']);
  const ALLOWED_RANGES = new Set(['1D', '5D', '1M', '3M', '6M', '12M', '60M']);

  /**
   * 외부 위젯에는 허용된 값만 전달한다. URL/DOM 값이 그대로 설정으로 들어가도
   * 차트가 깨지지 않도록 기본값으로 되돌리는 방어 코드다.
   */
  function normalizeChartSettings(settings = {}) {
    return {
      interval: ALLOWED_INTERVALS.has(settings.interval) ? settings.interval : DEFAULT_CHART_SETTINGS.interval,
      range: ALLOWED_RANGES.has(settings.range) ? settings.range : DEFAULT_CHART_SETTINGS.range
    };
  }

  function buildWidgetOptions(stock, settings) {
    const chartSettings = normalizeChartSettings(settings);
    return {
      autosize: true,
      symbol: buildSymbol(stock?.ticker, stock?.exchange),
      interval: chartSettings.interval,
      range: chartSettings.range,
      timezone: 'exchange',
      theme: 'dark',
      style: '1',
      locale: 'kr',
      // TradingView 공식 예제와 같은 RGBA 형식으로 전달해야 iframe 차트 배경에 확실히 적용된다.
      backgroundColor: 'rgba(17, 26, 34, 1)',
      gridColor: 'rgba(148, 163, 184, 0.08)',
      allow_symbol_change: false,
      calendar: false,
      details: false,
      hotlist: false,
      hide_side_toolbar: true,
      // 기간·시간 단위는 앱에서 제공하는 한글 조작 막대로 통일한다.
      hide_top_toolbar: true,
      hide_legend: false,
      hide_volume: false,
      save_image: false,
      withdateranges: false,
      studies: [
        'MASimple@tv-basicstudies',
        'WilliamsR@tv-basicstudies'
      ],
      studies_overrides: {
        // 기본 단순 이동평균을 사용자가 요청한 20일선으로 고정한다.
        'moving average.length': 20,
        'moving average.plot.color': '#facc15',
        'moving average.plot.linewidth': 2,
        // Williams %R의 기본 계산 기간은 14일이며 구분이 잘 되도록 색상만 조정한다.
        'williams %r.plot.color': '#38bdf8',
        'williams %r.plot.linewidth': 2
      },
      support_host: 'https://www.tradingview.com'
    };
  }

  /**
   * TradingView의 간접 삽입 스크립트는 방문자 브라우저의 저장된 테마가 설정을 덮어쓸 수 있다.
   * 따라서 iframe 주소의 검색 파라미터와 해시에 dark 설정을 함께 고정한다.
   */
  function buildWidgetUrl(stock, settings, frameId) {
    const options = buildWidgetOptions(stock, settings);
    const widgetUrl = new URL(EMBED_WIDGET_URL);
    widgetUrl.searchParams.set('locale', options.locale);
    widgetUrl.searchParams.set('theme', options.theme);
    widgetUrl.searchParams.set('backgroundColor', options.backgroundColor);
    widgetUrl.hash = encodeURIComponent(JSON.stringify({ ...options, frameElementId: frameId }));
    return widgetUrl.toString();
  }

  /**
   * 위젯 iframe은 종목 변경 때 기존 DOM을 완전히 비운다.
   * 같은 컨테이너에 iframe이 누적되면 입력 반응과 스크롤이 느려지는 문제가 생긴다.
   */
  function mount(container, stock, settings) {
    if (!container || !stock?.ticker) return;

    const symbol = buildSymbol(stock.ticker, stock.exchange);
    const chartSettings = normalizeChartSettings(settings);
    const settingsKey = `${chartSettings.interval}:${chartSettings.range}`;
    if (container.dataset.tradingViewSymbol === symbol
      && container.dataset.tradingViewSettings === settingsKey
      && container.querySelector('iframe')) return;

    container.replaceChildren();
    container.dataset.tradingViewSymbol = symbol;
    container.dataset.tradingViewSettings = settingsKey;
    container.classList.add('tradingview-chart-host');

    const loading = document.createElement('div');
    loading.className = 'tradingview-chart-loading';
    loading.innerHTML = '<i class="fa-solid fa-chart-line"></i><span>TradingView 차트를 불러오는 중입니다.</span>';

    const widgetContainer = document.createElement('div');
    widgetContainer.className = 'tradingview-widget-container';

    const frameId = `tv-${sanitizeTicker(stock.ticker).toLowerCase()}-${chartSettings.interval}-${chartSettings.range}`;
    const iframe = document.createElement('iframe');
    iframe.id = frameId;
    iframe.className = 'tradingview-widget-container__widget';
    iframe.title = `${sanitizeTicker(stock.ticker)} TradingView 차트`;
    iframe.loading = 'eager';
    iframe.setAttribute('allowtransparency', 'true');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('scrolling', 'no');
    iframe.src = buildWidgetUrl(stock, chartSettings, frameId);

    const copyright = document.createElement('div');
    copyright.className = 'tradingview-widget-copyright';
    const symbolPath = symbol.replace(':', '-');
    copyright.innerHTML = `<a href="https://www.tradingview.com/symbols/${encodeURIComponent(symbolPath)}/" rel="noopener nofollow" target="_blank"><span class="blue-text">${sanitizeTicker(stock.ticker)} 차트</span></a><span class="trademark"> by TradingView</span>`;

    iframe.addEventListener('load', () => loading.remove(), { once: true });
    iframe.addEventListener('error', () => {
      loading.classList.add('is-error');
      loading.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i><span>TradingView 연결에 실패했습니다. 네트워크 또는 광고 차단 설정을 확인해 주세요.</span>';
    }, { once: true });

    widgetContainer.append(iframe, copyright);
    container.append(loading, widgetContainer);
  }

  function unmount(container) {
    if (!container) return;
    container.replaceChildren();
    delete container.dataset.tradingViewSymbol;
    delete container.dataset.tradingViewSettings;
  }

  window.TradingViewCharts = {
    buildSymbol,
    buildOptions: buildWidgetOptions,
    buildUrl: buildWidgetUrl,
    normalizeSettings: normalizeChartSettings,
    mount,
    unmount
  };
})();
