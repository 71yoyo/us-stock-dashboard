/* 재무 UI 전용 모듈. SEC 저장값을 읽기만 하며 DB·API·다른 탭의 표시 정책은 변경하지 않는다. */
(() => {
  const colors = ['#38bdf8', '#2563eb', '#10b981'];
  const libraryUrl = 'https://cdn.jsdelivr.net/npm/echarts@6.0.0/dist/echarts.min.js';
  const libraryIntegrity = 'sha384-F07Cpw5v8spSU0H113F33m2NQQ/o6GqPTnTjf45ssG4Q6q58ZwhxBiQtIaqvnSpR';
  // 항목별로 필드·단위만 정의한다. 기간, 범위, tooltip, 생명주기는 같은 chart shell을 사용한다.
  const financialMetricConfigs = Object.freeze({
    growth: Object.freeze({ label: '성장·수익성', title: '성장·수익성', unit: 'combo', chartType: 'combo' }),
    operatingIncome: Object.freeze({ label: '영업이익', title: '영업이익', field: 'operatingIncome', unit: 'currency', chartType: 'bar' }),
    grossMargin: Object.freeze({ label: 'Gross Margin', title: 'Gross Margin', field: 'grossMargin', unit: 'percent', chartType: 'bar' }),
    operatingMargin: Object.freeze({ label: 'Oper. Margin', title: 'Operating Margin', field: 'operatingMargin', unit: 'percent', chartType: 'bar' })
  });
  const singleMetricConfigs = Object.entries(financialMetricConfigs).filter(([, config]) => config.field);
  let libraryPromise = null;
  let controller = null;

  function numberOrNull(value) {
    if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function netMargin(revenue, income) {
    const sales = numberOrNull(revenue), profit = numberOrNull(income);
    if (sales === null || profit === null || sales === 0) return null;
    return numberOrNull(profit / sales * 100);
  }

  /** 손실에서의 변화율도 같은 공식으로 표시하되 좋음/나쁨 또는 성장으로 단정하지 않는다. */
  function percentageChange(current, previous) {
    const value = numberOrNull(current), baseline = numberOrNull(previous);
    if (value === null || baseline === null || baseline === 0) return null;
    return numberOrNull((value - baseline) / Math.abs(baseline) * 100);
  }

  function formatAmount(value) {
    const number = numberOrNull(value);
    if (number === null) return '—';
    const unit = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']].find(([size]) => Math.abs(number) >= size);
    const amount = unit ? (Math.abs(number) / unit[0]).toFixed(2).replace(/\.00$/, '')
      : Math.abs(number).toLocaleString('en-US', { maximumFractionDigits: 2 });
    return `${number < 0 ? '-' : ''}$${amount}${unit?.[1] || ''}`;
  }

  function formatPercent(value, signed = false) {
    const number = numberOrNull(value);
    return number === null ? '—' : `${signed && number > 0 ? '+' : ''}${number.toFixed(2)}%`;
  }

  function getMetricConfig(key) {
    return Object.hasOwn(financialMetricConfigs, key) ? financialMetricConfigs[key] : financialMetricConfigs.growth;
  }

  function formatMetricValue(value, config) {
    return config.unit === 'percent' ? formatPercent(value) : formatAmount(value);
  }

  function hasMetricData(rows, metric = 'growth') {
    const config = getMetricConfig(metric);
    return rows.some(row => config.field ? numberOrNull(row[config.field]) !== null
      : numberOrNull(row.revenue) !== null || numberOrNull(row.netIncome) !== null);
  }

  function escapeText(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  /** 회계연도와 분기는 원본 metadata만 사용한다. 달력 연도/월로 보충하지 않는다. */
  function prepareFinancialData(financials, periodType) {
    const rows = (Array.isArray(financials) ? financials : [])
      .filter(row => row?.periodType === periodType)
      .map(row => {
        const year = numberOrNull(row.fiscalYear);
        const fiscalYear = Number.isInteger(year) && year >= 1000 && year <= 9999 ? year : null;
        const fiscalPeriod = /^(FY|Q[1-4])$/.test(row.fiscalPeriod) ? row.fiscalPeriod : null;
        const label = fiscalYear !== null && (periodType === 'annual' || /^Q[1-4]$/.test(fiscalPeriod))
          ? `${periodType === 'annual' ? 'FY' : `${fiscalPeriod} FY`}${fiscalYear}` : '기간 미확보';
        // 마진을 재계산하지 않고 API에 저장된 값을 그대로 읽는다.
        const metricValues = Object.fromEntries(singleMetricConfigs.map(([, config]) => [config.field, numberOrNull(row[config.field])]));
        return { ...row, ...metricValues, fiscalYear, fiscalPeriod, label, revenue: numberOrNull(row.revenue),
          netIncome: numberOrNull(row.netIncome), netMargin: netMargin(row.revenue, row.netIncome) };
      })
      .sort((left, right) => String(left.fiscalPeriodEnd || '').localeCompare(String(right.fiscalPeriodEnd || '')));
    const byFiscalPeriod = new Map(rows.filter(row => row.fiscalYear !== null)
      .map(row => [`${row.fiscalYear}:${periodType === 'annual' ? 'FY' : row.fiscalPeriod}`, row]));
    return rows.map(row => {
      const previousYear = byFiscalPeriod.get(`${row.fiscalYear - 1}:${periodType === 'annual' ? 'FY' : row.fiscalPeriod}`);
      const quarter = /^Q[1-4]$/.test(row.fiscalPeriod) ? Number(row.fiscalPeriod.slice(1)) : null;
      const previousQuarter = quarter && row.fiscalYear !== null
        ? byFiscalPeriod.get(`${quarter === 1 ? row.fiscalYear - 1 : row.fiscalYear}:Q${quarter === 1 ? 4 : quarter - 1}`) : null;
      const metricChanges = Object.fromEntries(singleMetricConfigs.map(([key, config]) => [key, {
        yoy: percentageChange(row[config.field], previousYear?.[config.field]),
        qoq: percentageChange(row[config.field], previousQuarter?.[config.field])
      }]));
      return { ...row, metricChanges, revenueYoY: percentageChange(row.revenue, previousYear?.revenue),
        incomeYoY: percentageChange(row.netIncome, previousYear?.netIncome),
        revenueQoQ: percentageChange(row.revenue, previousQuarter?.revenue),
        incomeQoQ: percentageChange(row.netIncome, previousQuarter?.netIncome) };
    });
  }

  function selectRange(rows, periodType, range = '12') {
    if (periodType === 'annual') return rows.slice(-10);
    return range === 'all' ? rows.slice() : rows.slice(-({ '8': 8, '12': 12, '20': 20 }[range] || 12));
  }

  function tooltipHtml(row, periodType, metric = 'growth') {
    if (!row) return '';
    const config = getMetricConfig(metric);
    const items = [];
    if (config.field) {
      items.push([config.title, formatMetricValue(row[config.field], config)]);
      // %p가 아니라 이전값의 절댓값 대비 변화율이다. 마진에도 중립적인 문구를 사용한다.
      if (periodType === 'quarterly') items.push(['QoQ 변화 (%)', formatPercent(row.metricChanges?.[metric]?.qoq, true)]);
      items.push(['YoY 변화 (%)', formatPercent(row.metricChanges?.[metric]?.yoy, true)]);
    } else {
      items.push(['매출', formatAmount(row.revenue)], ['순이익', formatAmount(row.netIncome)],
        ['순마진', formatPercent(row.netMargin)]);
      if (periodType === 'quarterly') items.push(['매출 전분기 대비', formatPercent(row.revenueQoQ, true)],
        ['순이익 전분기 대비', formatPercent(row.incomeQoQ, true)]);
      items.push(['매출 전년 대비', formatPercent(row.revenueYoY, true)], ['순이익 전년 대비', formatPercent(row.incomeYoY, true)]);
    }
    items.push(['기간', `${row.periodStart || '—'} ~ ${row.fiscalPeriodEnd || '—'}`], ['공시일', row.reportedDate || '—']);
    return `<div class="financial-tooltip"><strong>${escapeText(row.label)}</strong>${items.map(([label, value]) =>
      `<div><span>${escapeText(label)}</span><b>${escapeText(value)}</b></div>`).join('')}</div>`;
  }

  /** 순수 option 생성 함수여서 실제 라이브러리·DOM 없이 FY/Q, null, 음수, 범위를 검증할 수 있다. */
  function createChartOption(rows, periodType, range = '12', compact = false, metric = 'growth') {
    const zoom = periodType === 'quarterly' && (range === 'all' || range === '20') && rows.length > 12;
    const config = getMetricConfig(metric);
    const option = {
      animation: false, backgroundColor: 'transparent', color: colors,
      textStyle: { color: '#94a3b8', fontFamily: 'Inter, sans-serif' },
      aria: { enabled: true, label: { description: '매출과 순이익은 금액 막대, 순마진은 오른쪽 퍼센트 축의 선입니다.' } },
      legend: { top: 4, itemWidth: 13, itemHeight: 9, textStyle: { color: '#94a3b8', fontSize: 11 },
        data: ['매출', '순이익', '순마진'] },
      grid: { top: 62, left: compact ? 8 : 16, right: compact ? 8 : 16,
        bottom: zoom ? 66 : 20, containLabel: true },
      tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'shadow' },
        backgroundColor: '#111827', borderColor: '#334155', textStyle: { color: '#f8fafc', fontSize: 12 },
        extraCssText: 'max-width:100%;box-shadow:0 8px 24px #0006;',
        formatter: params => tooltipHtml(rows[(Array.isArray(params) ? params[0] : params)?.dataIndex], periodType, metric) },
      xAxis: { type: 'category', data: rows.map(row => row.label),
        axisLine: { lineStyle: { color: '#334155' } }, axisTick: { show: false },
        axisLabel: { color: '#94a3b8', fontSize: compact ? 9 : 11, hideOverlap: true, rotate: compact ? 35 : 0 } },
      yAxis: [
        { type: 'value', name: '금액 ($)', position: 'left', scale: false,
          nameTextStyle: { color: '#94a3b8', align: 'left' },
          axisLabel: { color: '#94a3b8', fontSize: 10, formatter: formatAmount },
          splitLine: { lineStyle: { color: '#ffffff0a' } }, axisLine: { show: false } },
        { type: 'value', name: '순마진 (%)', position: 'right', scale: false,
          nameTextStyle: { color: '#94a3b8', align: 'right' },
          axisLabel: { color: '#94a3b8', fontSize: 10, formatter: value => `${Number(value.toFixed(2))}%` },
          splitLine: { show: false }, axisLine: { show: false } }
      ],
      dataZoom: zoom ? [
        { type: 'inside', xAxisIndex: 0, filterMode: 'filter', startValue: Math.max(0, rows.length - 12), endValue: rows.length - 1 },
        { type: 'slider', xAxisIndex: 0, filterMode: 'filter', height: 20, bottom: 8,
          startValue: Math.max(0, rows.length - 12), endValue: rows.length - 1,
          borderColor: '#334155', backgroundColor: '#111827', fillerColor: '#38bdf81a',
          textStyle: { color: '#94a3b8' }, showDetail: false }
      ] : [],
      series: [
        { name: '매출', type: 'bar', yAxisIndex: 0, barMaxWidth: 28, barGap: '15%', data: rows.map(row => row.revenue) },
        { name: '순이익', type: 'bar', yAxisIndex: 0, barMaxWidth: 28, data: rows.map(row => row.netIncome) },
        { name: '순마진', type: 'line', yAxisIndex: 1, symbol: 'circle', symbolSize: 5,
          connectNulls: false, smooth: false, lineStyle: { width: 2 }, data: rows.map(row => row.netMargin) }
      ]
    };
    // Phase 2A 콤보의 축·series·legend는 그대로 둔다. 단일 지표는 공통 스타일에서 해당 부분만 바꾼다.
    if (!config.field) return option;
    return { ...option, color: [colors[0]], legend: { show: false },
      aria: { enabled: true, label: { description: `${config.title} ${config.unit === 'percent' ? '퍼센트' : '금액'} 막대 차트입니다.` } },
      yAxis: [{ ...option.yAxis[0], name: config.unit === 'percent' ? '비율 (%)' : '금액 ($)',
        axisLabel: { ...option.yAxis[0].axisLabel, formatter: value => formatMetricValue(value, config) } }],
      series: [{ name: config.title, type: config.chartType, yAxisIndex: 0, barMaxWidth: 28,
        data: rows.map(row => numberOrNull(row[config.field])) }] };
  }

  /** 빌드 없는 정적 앱: 버전 고정 CDN을 재무 탭에서만 로딩하며, 실패는 이 패널에 한정한다. */
  function loadLibrary() {
    if (globalThis.echarts) return Promise.resolve(globalThis.echarts);
    if (libraryPromise) return libraryPromise;
    libraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timeout = setTimeout(() => failed(), 12000);
      const failed = () => { clearTimeout(timeout); script.remove(); libraryPromise = null;
        reject(new Error('재무 차트 연결 실패')); };
      script.src = libraryUrl; script.integrity = libraryIntegrity; script.crossOrigin = 'anonymous'; script.async = true;
      script.onerror = failed;
      script.onload = () => { clearTimeout(timeout); if (globalThis.echarts) resolve(globalThis.echarts); else failed(); };
      document.head.appendChild(script);
    });
    return libraryPromise;
  }

  function createController(root, dependencies = {}) {
    const host = root.querySelector('#detailFinancialMetrics');
    const status = root.querySelector('[data-financial-status]');
    const retry = root.querySelector('[data-financial-retry]');
    const load = dependencies.loadLibrary || loadLibrary;
    let company = null, mode = 'annual', range = '12', metric = 'growth', instance = null, observer = null, epoch = 0;

    const isVisible = () => !root.classList.contains('hidden')
      && !root.closest('#companyDetailModal')?.classList.contains('hidden') && host.clientWidth > 0;
    function release() {
      epoch += 1; observer?.disconnect(); observer = null;
      instance?.dispose(); instance = null;
    }
    function resize() {
      if (instance && isVisible()) instance.resize();
    }
    function message(text, canRetry = false) {
      status.textContent = text; status.hidden = !text; retry.hidden = !canRetry;
    }
    async function update() {
      const config = getMetricConfig(metric);
      const allRows = prepareFinancialData(company?.financials, mode);
      const rows = selectRange(allRows, mode, range);
      const latest = rows.at(-1);
      // 빈 상태에서도 이전 종목·지표의 접근성 설명이 남지 않게 한다.
      host.setAttribute('aria-label', `${company?.ticker || ''} ${mode === 'annual' ? '연간' : '분기'} ${config.title} ${rows.length}개 기간`);
      root.querySelector('#financialGrowthTitle').textContent = config.title;
      root.querySelector('[data-financial-latest]').textContent = latest?.label || '기간 미확보';
      for (const [name, value] of Object.entries({ revenue: formatAmount(latest?.revenue),
        income: formatAmount(latest?.netIncome), margin: formatPercent(latest?.netMargin) })) {
        root.querySelector(`[data-financial-value="${name}"]`).textContent = value;
      }
      root.querySelectorAll('[data-financial-summary-growth]').forEach(element => { element.hidden = !!config.field; });
      root.querySelector('[data-financial-summary-single]').hidden = !config.field;
      root.querySelector('[data-financial-label]').textContent = config.title;
      root.querySelector('[data-financial-value="metric"]').textContent = formatMetricValue(latest?.[config.field], config);
      root.querySelectorAll('[data-financial-metric]').forEach(button => {
        const active = button.dataset.financialMetric === metric;
        button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
      });
      root.querySelector('[data-financial-ranges]').hidden = mode !== 'quarterly';
      root.querySelectorAll('[data-financial-period]').forEach(button => {
        const active = button.dataset.financialPeriod === mode;
        button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
      });
      root.querySelectorAll('[data-financial-range]').forEach(button => {
        const active = button.dataset.financialRange === range;
        button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
      });
      const missingMetadata = rows.some(row => row.label === '기간 미확보');
      root.querySelector('#detailFinancialSource').textContent =
        `SEC EDGAR 저장 이력 · ${mode === 'annual' ? '연간' : '분기'} ${rows.length}개 · ${config.field ? `${config.title} 저장값${config.unit === 'percent' ? ' · 변화율은 %p가 아닌 % 변화' : ''}` : '순마진 = 순이익 ÷ 매출'}${missingMetadata ? ' · FY/Q 미확보 기간은 추정하지 않습니다.' : ''}`;
      if (!hasMetricData(rows, metric)) {
        release();
        message(config.field ? '이 기간에 사용할 수 있는 데이터가 없습니다. 5-3 수집 현황을 확인해 주세요.'
          : '저장된 매출·순이익 데이터가 없습니다. 5-3 수집 현황을 확인해 주세요.'); return;
      }
      if (!isVisible()) return;
      const requestEpoch = ++epoch;
      try {
        if (!instance) message('재무 차트를 불러오는 중입니다.');
        const library = await load();
        // 모달 닫기·종목 교체·탭 변경 뒤 도착한 로딩 응답은 차트를 다시 생성하지 않는다.
        if (requestEpoch !== epoch || !isVisible()) return;
        if (!instance) {
          instance = library.init(host, null, { renderer: 'canvas' });
          if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(resize); observer.observe(host); }
        }
        instance.setOption(createChartOption(rows, mode, range, host.clientWidth < 600, metric), { notMerge: true });
        message(''); resize();
      } catch {
        if (requestEpoch !== epoch) return;
        release(); message('재무 차트를 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 다시 불러오세요. 위 요약값과 다른 화면은 계속 사용할 수 있습니다.', true);
      }
    }
    // 고정 패널에 위임 이벤트를 한 번만 등록한다. 재렌더링으로 리스너가 늘어나지 않는다.
    root.addEventListener('click', event => {
      const period = event.target.closest('[data-financial-period]');
      const selection = event.target.closest('[data-financial-range]');
      const metricButton = event.target.closest('[data-financial-metric]');
      if (metricButton) {
        if (metricButton.disabled || !Object.hasOwn(financialMetricConfigs, metricButton.dataset.financialMetric)) return;
        metric = metricButton.dataset.financialMetric;
      } else if (period) mode = period.dataset.financialPeriod;
      else if (selection) range = selection.dataset.financialRange;
      else if (!event.target.closest('[data-financial-retry]')) return;
      void update();
    });
    globalThis.addEventListener?.('resize', resize);
    return {
      setCompany(nextCompany) {
        if (nextCompany?.ticker !== company?.ticker) { release(); mode = 'annual'; range = '12'; }
        company = nextCompany; void update();
      },
      prepareTicker(ticker) {
        if (ticker !== company?.ticker) this.setCompany({ ticker, financials: [] });
      },
      show: () => void update(), dispose: release
    };
  }

  function getController() {
    const root = globalThis.document?.querySelector('[data-detail-panel="financials"]');
    if (root && !controller) controller = createController(root);
    return controller;
  }
  globalThis.FinancialChart = Object.freeze({ loadLibrary, financialMetricConfigs, formatMetricValue, hasMetricData, numberOrNull, netMargin, percentageChange, formatAmount,
    formatPercent, prepareFinancialData, selectRange, tooltipHtml, createChartOption, createController,
    render: company => getController()?.setCompany(company),
    prepareTicker: ticker => getController()?.prepareTicker(ticker),
    show: () => getController()?.show(), dispose: () => controller?.dispose() });
})();
