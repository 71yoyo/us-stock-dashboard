/* REIT 공시 저장값의 읽기 전용 UI. GENERAL 계산과 DB/수집 경로에는 관여하지 않는다. */
(() => {
  const general = globalThis.FinancialChart;
  const metrics = ['FFO', 'NORMALIZED_FFO', 'AFFO'];
  const labels = { FFO: 'FFO', NORMALIZED_FFO: 'NFFO', AFFO: 'AFFO' };
  const configs = Object.freeze({
    core: { label: 'REIT 핵심', metrics, basis: 'total', shareBasis: 'not_applicable' },
    ffo: { label: 'FFO', metrics: ['FFO'], basis: 'total', shareBasis: 'not_applicable' },
    nffo: { label: 'Normalized FFO', metrics: ['NORMALIZED_FFO'], basis: 'total', shareBasis: 'not_applicable' },
    affo: { label: 'AFFO', metrics: ['AFFO'], basis: 'total', shareBasis: 'not_applicable' },
    ffoShare: { label: 'FFO/주', metrics: ['FFO'], basis: 'per_share', shareBasis: 'diluted' },
    nffoShare: { label: 'NFFO/주', metrics: ['NORMALIZED_FFO'], basis: 'per_share', shareBasis: 'diluted' },
    affoShare: { label: 'AFFO/주', metrics: ['AFFO'], basis: 'per_share', shareBasis: 'diluted' }
  });
  const colors = ['#38bdf8', '#a78bfa', '#10b981'];
  const isReit = company => company?.analysisProfile?.type === 'REIT';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
  const periodKey = row => `${row.fiscalYear}:${row.fiscalPeriod}:${row.periodStart}:${row.periodEnd}`;
  const formatValue = (value, basis) => basis === 'per_share'
    ? (general.numberOrNull(value) === null ? '—' : `$${Number(value).toFixed(2)}`) : general.formatAmount(value);

  /** 미확보 값을 보정하지 않는다. 정의·귀속까지 일치하는 실제 회계기간만 비교한다. */
  function change(current, previous) {
    if (!current || !previous) return { value: null, reason: 'missing' };
    if (['metric', 'basis', 'shareBasis', 'definitionVersion', 'definitionOwner', 'attributionBasis']
      .some(key => current[key] !== previous[key])) return { value: null, reason: 'definition' };
    return { value: general.percentageChange(current.value, previous.value), reason: null };
  }
  const formatChange = result => result?.reason === 'definition'
    ? '— (정의 변경)' : general.formatPercent(result?.value, true);

  /** 세 저장 series의 기간 합집합을 유지한다. 중복 정의는 합산/선택하지 않고 검토 gap으로 둔다. */
  function prepareData(payloads, scope) {
    const periods = new Map();
    for (const payload of payloads) for (const record of payload.data) {
      const key = periodKey(record);
      if (!periods.has(key)) periods.set(key, { key, fiscalYear: record.fiscalYear, fiscalPeriod: record.fiscalPeriod,
        periodStart: record.periodStart, periodEnd: record.periodEnd,
        label: `${scope === 'annual' ? 'FY' : `${record.fiscalPeriod} FY`}${record.fiscalYear}`, entries: {}, boundaries: [] });
      const row = periods.get(key);
      (row.entries[payload.metric] ||= []).push({ ...record, metric: payload.metric,
        basis: payload.basis, shareBasis: payload.shareBasis });
    }
    const rows = [...periods.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)
      || a.periodStart.localeCompare(b.periodStart) || a.key.localeCompare(b.key));
    for (const payload of payloads) for (const boundary of payload.definitionBoundaries) {
      const row = periods.get(periodKey(boundary));
      if (row) row.boundaries.push({ ...boundary, metric: payload.metric });
    }
    for (const row of rows) {
      row.records = {}; row.values = {}; row.changes = {};
      for (const metric of metrics) {
        const entries = row.entries[metric] || [];
        row.records[metric] = entries.length === 1 ? entries[0] : null;
        row.values[metric] = general.numberOrNull(row.records[metric]?.value);
      }
    }
    // 같은 FY/FQ가 서로 다른 기간에 있으면 변화율도 모호하므로 계산하지 않는다.
    const fiscal = new Map();
    for (const row of rows) {
      const key = `${row.fiscalYear}:${row.fiscalPeriod}`;
      fiscal.set(key, fiscal.has(key) ? null : row);
    }
    for (const row of rows) for (const metric of metrics) {
      const unambiguous = fiscal.get(`${row.fiscalYear}:${row.fiscalPeriod}`) === row;
      const previousYear = fiscal.get(`${row.fiscalYear - 1}:${row.fiscalPeriod}`);
      const q = Number(row.fiscalPeriod.slice(1));
      const previousQuarter = scope === 'quarterly' && q >= 1 && q <= 4
        ? fiscal.get(`${q === 1 ? row.fiscalYear - 1 : row.fiscalYear}:Q${q === 1 ? 4 : q - 1}`) : null;
      row.changes[metric] = { yoy: change(unambiguous ? row.records[metric] : null, previousYear?.records[metric]),
        qoq: change(unambiguous ? row.records[metric] : null, previousQuarter?.records[metric]) };
    }
    return rows;
  }

  function tooltipHtml(row, scope, config) {
    if (!row) return '';
    const items = [['회계연도 / 기간', `${row.fiscalYear} / ${row.fiscalPeriod}`],
      ['기간 시작 / 종료', `${row.periodStart} ~ ${row.periodEnd}`]];
    for (const metric of config.metrics) {
      const record = row.records[metric];
      items.push([labels[metric], formatValue(row.values[metric], config.basis)]);
      if ((row.entries[metric]?.length || 0) > 1) items.push(['정의 검토', '복수 정의 저장 · 값을 합산하지 않음']);
      else if (record) {
        items.push([`${labels[metric]} 정의 버전`, record.definitionVersion],
          [`${labels[metric]} 검증 상태`, record.validationStatus]);
      } else items.push([`${labels[metric]} 공시`, '이 기간의 저장값 없음']);
      if (scope === 'quarterly') items.push([`${labels[metric]} QoQ`, formatChange(row.changes[metric]?.qoq)]);
      items.push([`${labels[metric]} YoY`, formatChange(row.changes[metric]?.yoy)]);
    }
    const boundaries = row.boundaries.filter(item => config.metrics.includes(item.metric));
    items.push(['정의 변경', boundaries.length ? boundaries.map(item => labels[item.metric]).join(' · ') : '없음']);
    return `<div class="financial-tooltip reit-tooltip"><strong>${escape(row.label)}</strong>${items.map(([name, value]) =>
      `<div><span>${escape(name)}</span><b>${escape(value)}</b></div>`).join('')}</div>`;
  }

  function createChartOption(rows, scope, range, compact, config, ticker = '') {
    const zoom = scope === 'quarterly' && ['all', '20'].includes(range) && rows.length > 12;
    const boundaries = rows.filter(row => row.boundaries.some(item => config.metrics.includes(item.metric)));
    return {
      animation: false, backgroundColor: 'transparent', color: config.metrics.map(metric => colors[metrics.indexOf(metric)]),
      textStyle: { color: '#94a3b8', fontFamily: 'Inter, sans-serif' },
      aria: { enabled: true, label: { description: `${ticker} ${scope === 'annual' ? '연간' : '분기'} ${config.label} ${rows.length}개 기간 공시 저장값 막대 차트. 점선은 정의 변경입니다.` } },
      legend: { top: 4, itemWidth: 13, itemHeight: 9, textStyle: { color: '#94a3b8', fontSize: 11 },
        data: config.metrics.map(metric => labels[metric]) },
      grid: { top: 62, left: compact ? 8 : 16, right: compact ? 8 : 16, bottom: zoom ? 66 : 20, containLabel: true },
      tooltip: { trigger: 'axis', confine: true, enterable: true, axisPointer: { type: 'shadow' },
        backgroundColor: '#111827', borderColor: '#334155', textStyle: { color: '#f8fafc', fontSize: compact ? 10 : 12 },
        extraCssText: 'max-width:calc(100% - 8px);max-height:100%;overflow:auto;white-space:normal;',
        formatter: params => tooltipHtml(rows[(Array.isArray(params) ? params[0] : params)?.dataIndex], scope, config) },
      xAxis: { type: 'category', data: rows.map(row => row.label), axisLine: { lineStyle: { color: '#334155' } },
        axisTick: { show: false }, axisLabel: { fontSize: compact ? 9 : 11, hideOverlap: true, rotate: compact ? 35 : 0 } },
      yAxis: [{ type: 'value', name: config.basis === 'per_share' ? '희석 주당 ($)' : '금액 ($)',
        nameTextStyle: { color: '#94a3b8', align: 'left' }, axisLabel: { fontSize: 10, formatter: value => formatValue(value, config.basis) },
        splitLine: { lineStyle: { color: '#ffffff0a' } }, axisLine: { show: false } }],
      dataZoom: zoom ? [
        { type: 'inside', xAxisIndex: 0, filterMode: 'filter', startValue: Math.max(0, rows.length - 12), endValue: rows.length - 1 },
        { type: 'slider', xAxisIndex: 0, filterMode: 'filter', height: 20, bottom: 8, startValue: Math.max(0, rows.length - 12),
          endValue: rows.length - 1, borderColor: '#334155', backgroundColor: '#111827', fillerColor: '#38bdf81a', showDetail: false }
      ] : [],
      series: config.metrics.map((metric, index) => ({ name: labels[metric], type: 'bar', yAxisIndex: 0,
        barMaxWidth: 28, barGap: '15%', data: rows.map(row => row.values[metric]),
        // 동일 기간 여러 지표의 경계는 한 점선으로 표시하고 tooltip에서 해당 지표를 구분한다.
        ...(index === 0 ? { markLine: { silent: true, symbol: ['none', 'none'], label: { show: false },
          lineStyle: { color: '#94a3b8', width: 1, type: 'dashed', opacity: 0.6 },
          data: boundaries.map(row => ({ xAxis: rows.indexOf(row), name: '정의 변경' })) } } : {}) }))
    };
  }

  /** 한 modal session에서 scope/basis별 세 요청을 공유한다. 닫기/종목 변경은 모두 취소한다. */
  function createClient({ fetcher = (...args) => fetch(...args), apiUrl } = {}) {
    const cache = new Map();
    async function read(ticker, scope, config) {
      const key = `${ticker}:${scope}:${config.basis}:${config.shareBasis}`;
      if (cache.has(key)) return cache.get(key).promise;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const promise = Promise.all(metrics.map(async metric => {
        const params = new URLSearchParams({ metric, scope, basis: config.basis, shareBasis: config.shareBasis });
        const url = apiUrl(`/api/companies/${encodeURIComponent(ticker)}/specialized-metrics?${params}`);
        if (!url) throw new Error('API 주소 미설정');
        const response = await fetcher(url, { signal: controller.signal });
        if (!response.ok) throw new Error('저장 데이터 조회 실패');
        const payload = await response.json();
        // 다른 종목/기준 및 YTD 응답을 현재 화면에 섞지 않는다.
        if (payload.ticker !== ticker || payload.metric !== metric || payload.scope !== scope
          || payload.basis !== config.basis || payload.shareBasis !== config.shareBasis
          || !Array.isArray(payload.data) || !Array.isArray(payload.definitionBoundaries)
          || payload.data.some(row => !Number.isInteger(row.fiscalYear)
            || !(scope === 'annual' ? row.fiscalPeriod === 'FY' : /^Q[1-4]$/.test(row.fiscalPeriod))
            || !/^\d{4}-\d{2}-\d{2}$/.test(row.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(row.periodEnd)
            || row.unit !== (config.basis === 'total' ? 'USD' : 'USD/share')
            || !row.definitionVersion || !['parsed', 'validated'].includes(row.validationStatus))) {
          throw new Error('저장 데이터 기준 불일치');
        }
        return payload;
      })).catch(error => {
        controller.abort();
        if (cache.get(key)?.controller === controller) cache.delete(key);
        throw error;
      }).finally(() => clearTimeout(timer));
      cache.set(key, { promise, controller });
      return promise;
    }
    return { read, clear() { for (const entry of cache.values()) entry.controller.abort(); cache.clear(); } };
  }

  function createController(root, dependencies = {}) {
    const host = root.querySelector('#detailReitFinancialMetrics');
    const status = root.querySelector('[data-reit-status]'), retry = root.querySelector('[data-reit-retry]');
    const client = dependencies.client || createClient({ apiUrl: path => {
      const base = globalThis.US_STOCK_PRO_CONFIG?.apiBaseUrl?.replace(/\/$/, '') || '';
      return base ? `${base}${path}` : '';
    } });
    const loadLibrary = dependencies.loadLibrary || general.loadLibrary;
    let company = null, scope = 'annual', range = '12', metric = 'core', epoch = 0, instance = null, observer = null;
    const visible = () => !root.hidden && !root.closest('[data-detail-panel]')?.classList.contains('hidden')
      && !root.closest('#companyDetailModal')?.classList.contains('hidden') && host.clientWidth > 0;
    const resize = () => { if (visible()) instance?.resize(); };
    function disposeChart() { observer?.disconnect(); observer = null; instance?.dispose(); instance = null; }
    function dispose() { ++epoch; client.clear(); disposeChart(); }
    function message(text, canRetry = false) { status.textContent = text; status.hidden = !text; retry.hidden = !canRetry; }
    function header(config, rows = []) {
      host.setAttribute('aria-label', `${company?.ticker || ''} ${scope === 'annual' ? '연간' : '분기'} ${config.label} ${rows.length}개 기간 · 공시 정의 변경 점선`);
      root.querySelector('#reitFinancialTitle').textContent = config.label;
      const latest = rows.at(-1);
      root.querySelector('[data-reit-latest]').textContent = latest?.label || '기간 미확보';
      root.querySelector('[data-reit-summary]').innerHTML = config.metrics.map(key =>
        `<div><dt>${escape(labels[key])}${config.basis === 'per_share' ? '/주' : ''}</dt><dd>${escape(formatValue(latest?.values[key], config.basis))}</dd></div>`).join('');
      root.querySelector('[data-reit-ranges]').hidden = scope !== 'quarterly';
      for (const [kind, value] of [['metric', metric], ['period', scope], ['range', range]]) {
        root.querySelectorAll(`[data-reit-${kind}]`).forEach(button => {
          const active = button.getAttribute(`data-reit-${kind}`) === value;
          button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
        });
      }
    }
    async function update() {
      const config = configs[metric], generation = ++epoch, ticker = company?.ticker;
      header(config);
      if (!isReit(company) || !visible()) return;
      // 로딩/실패 중 이전 지표 canvas와 summary를 최신값처럼 남기지 않는다.
      disposeChart(); message('저장된 REIT 재무 데이터를 불러오는 중입니다.');
      root.querySelector('[data-reit-source]').textContent = '';
      try {
        const payloads = await client.read(ticker, scope, config);
        if (generation !== epoch || !visible()) return;
        const rows = general.selectRange(prepareData(payloads, scope), scope, range);
        header(config, rows);
        const boundaryCount = rows.filter(row => row.boundaries.some(item => config.metrics.includes(item.metric))).length;
        root.querySelector('[data-reit-source]').textContent = `회사 공식 공시 저장값 · ${scope === 'annual' ? '연간' : '분기'} ${rows.length}개 기간 · ${config.basis === 'total' ? 'common total' : '희석 주당'} · 정의 변경 ${boundaryCount}개 기간 · 미공시/복수 정의는 gap`;
        if (!rows.some(row => config.metrics.some(key => row.values[key] !== null))) {
          message('이 기간에 사용할 수 있는 데이터가 없습니다.'); return;
        }
        const library = await loadLibrary();
        if (generation !== epoch || !visible()) return;
        instance = library.init(host, null, { renderer: 'canvas' });
        if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(resize); observer.observe(host); }
        instance.setOption(createChartOption(rows, scope, range, host.clientWidth < 600, config, ticker), { notMerge: true });
        message(''); resize();
      } catch {
        if (generation !== epoch || !visible()) return;
        disposeChart(); message('REIT 재무 데이터를 불러오지 못했습니다. 연결을 확인한 뒤 다시 불러오세요. 다른 탭과 저장 데이터는 유지됩니다.', true);
      }
    }
    root.addEventListener('click', event => {
      const select = event.target.closest('[data-reit-metric]');
      const period = event.target.closest('[data-reit-period]');
      const selectedRange = event.target.closest('[data-reit-range]');
      if (select && Object.hasOwn(configs, select.dataset.reitMetric)) metric = select.dataset.reitMetric;
      else if (period && ['annual', 'quarterly'].includes(period.dataset.reitPeriod)) scope = period.dataset.reitPeriod;
      else if (selectedRange && ['8', '12', '20', 'all'].includes(selectedRange.dataset.reitRange)) range = selectedRange.dataset.reitRange;
      else if (event.target.closest('[data-reit-retry]')) client.clear();
      else return;
      void update();
    });
    globalThis.addEventListener?.('resize', resize);
    return { setCompany(next) {
      if (next?.ticker !== company?.ticker) { dispose(); metric = 'core'; scope = 'annual'; range = '12'; }
      company = next; void update();
    }, show: () => void update(), dispose };
  }

  /** profile가 없는 로딩 상태는 안전한 기존 화면으로 둔다. ticker 이름으로 전문 UI를 결정하지 않는다. */
  function createPanel(root, generalChart = general, factory = createController) {
    const generalRoot = root.querySelector('[data-general-financial]'), reitRoot = root.querySelector('[data-reit-financial]');
    let reitController = null, reit = false;
    function select(company) {
      reit = isReit(company); generalRoot.hidden = reit; reitRoot.hidden = !reit;
      if (reit) { generalChart.dispose(); (reitController ||= factory(reitRoot)).setCompany(company); }
      else { reitController?.dispose(); generalChart.render(company); }
    }
    return { render: select, prepareTicker(ticker) {
      generalChart.dispose(); reitController?.dispose(); reit = false;
      generalRoot.hidden = false; reitRoot.hidden = true; generalChart.prepareTicker(ticker);
    }, show() { if (reit) reitController?.show(); else generalChart.show(); },
    dispose() { generalChart.dispose(); reitController?.dispose(); } };
  }
  let panel;
  function getPanel() {
    const root = globalThis.document?.querySelector('[data-detail-panel="financials"]');
    return root ? (panel ||= createPanel(root)) : null;
  }
  globalThis.ReitFinancialChart = Object.freeze({ configs, isReit, periodKey, formatValue, change, formatChange,
    prepareData, tooltipHtml, createChartOption, createClient, createController, createPanel });
  globalThis.FinancialPanel = Object.freeze({ render: company => getPanel()?.render(company),
    prepareTicker: ticker => getPanel()?.prepareTicker(ticker), show: () => getPanel()?.show(), dispose: () => getPanel()?.dispose() });
})();
