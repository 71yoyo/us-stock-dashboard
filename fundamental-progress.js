/* 금융 원본은 서버에 두고 이 모듈은 진행률만 메모리에 보관한다. 이벤트/타이머는 한 번만 등록한다. */
(() => {
  let running = false;
  let timer = null;
  const message = document.getElementById('fundamentalMessage');
  const runButton = document.getElementById('fundamentalRunBtn');
  const labels = { ready: '저장됨', partial: '일부 저장', pending: '대기', running: '수집 중', error: '미확보·재시도 대기' };

  async function request(path, method = 'GET') {
    if (!state.apiPin) throw new Error('PIN 잠금을 해제해 주세요.');
    const url = getCloudflareApiUrl(path);
    if (!url) throw new Error('서버 연결 주소가 설정되지 않았습니다.');
    const response = await fetch(url, getCloudflareRequestOptions({ method }));
    if (!response.ok) throw new Error(`수집 서버 응답 오류 (${response.status}). 잠시 후 다시 확인해 주세요.`);
    return response.json();
  }

  function render(status) {
    const summary = status.summary;
    const processed = Object.values(summary).reduce((sum, row) => sum + row.processed, 0);
    const total = Object.values(summary).reduce((sum, row) => sum + row.total, 0);
    const text = `수집 확인 ${processed}/${total} · 회사 ${summary.profile.stored}/${summary.profile.total} · 재무 ${summary.financials.stored}/${summary.financials.total} · 배당 ${summary.dividends.stored}/${summary.dividends.total} 저장 (부분 포함)`;
    document.getElementById('fundamentalSummary').textContent = `${text} · 자세한 내용: 5-3 메뉴`;
    message.textContent = running ? `${text} — 수집 중` : text;
    const progress = document.getElementById('fundamentalProgress');
    progress.max = total || 1;
    progress.value = processed;
    const body = document.getElementById('fundamentalRows');
    body.replaceChildren();
    for (const job of status.jobs) {
      const details = job.details || {};
      const range = [details.source,
        details.annualCount != null ? `연간 ${details.annualCount}개` : '',
        details.quarterlyCount != null ? `분기 ${details.quarterlyCount}개` : '',
        details.eventCount != null ? `배당 이벤트 ${details.eventCount}개` : '',
        job.error || details.note || ''].filter(Boolean).join(' · ');
      const row = document.createElement('tr');
      [job.ticker, job.label, labels[job.status] || job.status, range || '최초 수집 대기',
        job.nextRunAt ? new Date(job.nextRunAt).toLocaleString('ko-KR') : '곧 확인'].forEach((value, index) => {
        const cell = document.createElement('td');
        // API 오류 메시지도 textContent로 넣어 외부 문자열이 HTML로 실행되지 않게 한다.
        cell.textContent = value;
        if (index === 2) cell.dataset.status = job.status;
        row.appendChild(cell);
      });
      body.appendChild(row);
    }
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
        // 각 응답이 끝난 뒤 다음 묶음을 요청한다. 병렬 호출과 무제한 재시도를 만들지 않는다.
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
