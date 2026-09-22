/* 금융 원본은 서버에 두고 이 모듈은 저장 상태만 표시한다. 이벤트와 타이머는 한 번만 등록한다. */
(() => {
  let running = false;
  let timer = null;
  const message = document.getElementById('fundamentalMessage');
  const runButton = document.getElementById('fundamentalRunBtn');
  const labels = { ready: '저장됨', partial: '일부 저장', pending: '대기', running: '수집 중', error: '재시도 대기' };

  async function request(path, method = 'GET') {
    if (!state.apiPin) throw new Error('PIN 잠금을 해제해 주세요.');
    const url = getCloudflareApiUrl(path);
    if (!url) throw new Error('서버 연결 주소가 설정되지 않았습니다.');
    const response = await fetch(url, getCloudflareRequestOptions({ method }));
    if (!response.ok) throw new Error(`수집 서버 응답 오류 (${response.status}). 잠시 후 다시 확인해 주세요.`);
    return response.json();
  }

  function getSummary(summary, key) {
    return summary?.[key] || { total: 0, processed: 0, stored: 0, pending: 0 };
  }

  function formatDateTime(value, fallback = '확인 대기') {
    if (!value) return fallback;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('ko-KR') : fallback;
  }

  function createStatusBadge(status) {
    const badge = document.createElement('span');
    badge.className = 'fundamental-status-badge';
    badge.dataset.status = status || 'pending';
    badge.textContent = labels[status] || '확인 대기';
    return badge;
  }

  function appendDetail(cell, text, className = '') {
    const detail = document.createElement('span');
    detail.className = `fundamental-cell-detail ${className}`.trim();
    detail.textContent = text;
    cell.appendChild(detail);
  }

  function createJobCell(job) {
    const cell = document.createElement('td');
    cell.className = 'fundamental-data-cell';
    if (!job) {
      cell.appendChild(createStatusBadge('pending'));
      appendDetail(cell, '등록·수집 대기');
      return cell;
    }

    const details = job.details || {};
    const range = [
      details.source,
      details.annualCount != null ? `연간 ${details.annualCount}개` : '',
      details.quarterlyCount != null ? `분기 ${details.quarterlyCount}개` : '',
      details.eventCount != null ? `이벤트 ${details.eventCount}개` : '',
      job.error || details.note || ''
    ].filter(Boolean).join(' · ');
    cell.appendChild(createStatusBadge(job.status));
    appendDetail(cell, range || '최초 수집 대기');
    return cell;
  }

  function formatPrice(value) {
    return Number.isFinite(Number(value))
      ? `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '현재가 미저장';
  }

  function createMarketCell(stock) {
    const cell = document.createElement('td');
    cell.className = 'fundamental-data-cell fundamental-market-cell';
    const price = stock.price || {};
    const candles = stock.candles || {};
    cell.appendChild(createStatusBadge(stock.marketStatus || 'pending'));

    const change = Number.isFinite(Number(price.changePercent))
      ? ` · ${Number(price.changePercent) >= 0 ? '+' : ''}${Number(price.changePercent).toFixed(2)}%`
      : '';
    appendDetail(cell, `현재가 ${formatPrice(price.currentPrice)}${change}`, 'fundamental-price-value');
    appendDetail(cell, `3개월 일봉 ${Number(candles.count || 0)}개`);
    appendDetail(cell, `시세 ${formatDateTime(price.updatedAt)} · 일봉 ${formatDateTime(candles.updatedAt)}`, 'fundamental-cell-time');
    if (price.status === 'error' || candles.status === 'error') {
      appendDetail(cell, price.error || candles.error || '자동 재시도 대기', 'fundamental-cell-error');
    }
    return cell;
  }

  function createTickerCell(ticker) {
    const cell = document.createElement('th');
    cell.scope = 'row';
    cell.className = 'fundamental-ticker-cell';
    cell.textContent = ticker;
    return cell;
  }

  function renderRows(status) {
    const body = document.getElementById('fundamentalRows');
    body.replaceChildren();
    const stocks = Array.isArray(status.stocks) ? status.stocks : [];

    for (const stock of stocks) {
      const row = document.createElement('tr');
      row.appendChild(createTickerCell(stock.ticker));
      row.appendChild(createMarketCell(stock));
      row.appendChild(createJobCell(stock.jobs?.profile));
      row.appendChild(createJobCell(stock.jobs?.financials));
      row.appendChild(createJobCell(stock.jobs?.dividends));

      const nextCell = document.createElement('td');
      nextCell.className = 'fundamental-next-check';
      nextCell.textContent = formatDateTime(stock.nextCheckAt, '자동 수집 대기');
      row.appendChild(nextCell);
      body.appendChild(row);
    }
  }

  function render(status) {
    const summary = status.summary || {};
    const categories = ['price', 'candles', 'profile', 'financials', 'dividends'];
    const processed = categories.reduce((sum, key) => sum + getSummary(summary, key).processed, 0);
    const total = categories.reduce((sum, key) => sum + getSummary(summary, key).total, 0);
    const price = getSummary(summary, 'price');
    const candles = getSummary(summary, 'candles');
    const profile = getSummary(summary, 'profile');
    const financials = getSummary(summary, 'financials');
    const dividends = getSummary(summary, 'dividends');
    const text = `저장 확인 ${processed}/${total} · 현재가 ${price.stored}/${price.total} · 3개월 일봉 ${candles.stored}/${candles.total} · 회사 ${profile.stored}/${profile.total} · 재무 ${financials.stored}/${financials.total} · 배당 ${dividends.stored}/${dividends.total}`;
    document.getElementById('fundamentalSummary').textContent = `${text} · 자세한 내용: 5-3 메뉴`;
    message.textContent = running ? `${text} — 회사·재무·배당 수집 중` : text;
    const progress = document.getElementById('fundamentalProgress');
    progress.max = total || 1;
    progress.value = processed;
    renderRows(status);
  }

  async function refresh() {
    if (!state.apiPin || document.hidden || mainApp.classList.contains('hidden')) return;
    try { render(await request('/api/fundamentals/status')); }
    catch (error) { message.textContent = error.message; }
  }

  async function run() {
    if (running) return;
    running = true;
    runButton.disabled = true;
    try {
      for (let batch = 0; batch < 300; batch += 1) {
        if (!state.apiPin || mainApp.classList.contains('hidden')) break;
        const result = await request('/api/fundamentals/run', 'POST');
        render(result.status);
        if (!result.results.length) break;
        // 각 응답 뒤에 다음 묶음을 요청해 병렬 호출과 무제한 재시도를 만들지 않는다.
        const due = result.status.jobs.some(job => !job.nextRunAt || new Date(job.nextRunAt).getTime() <= Date.now());
        if (!due) break;
      }
    } catch (error) { message.textContent = error.message; }
    finally {
      running = false;
      runButton.disabled = false;
      await refresh();
      if (state.selectedTicker) {
        const company = await fetchCompanyFromCloudflare(state.selectedTicker);
        if (company) renderCompanyDetailData(company);
      }
    }
  }

  runButton.addEventListener('click', run);
  document.getElementById('fundamentalRefreshBtn').addEventListener('click', refresh);
  window.FundamentalProgress = {
    start() {
      void refresh();
      if (!timer) timer = setInterval(() => { if (!running) void refresh(); }, 30000);
    }, refresh
  };
})();
