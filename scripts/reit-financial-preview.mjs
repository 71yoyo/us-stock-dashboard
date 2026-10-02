import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import '../financial-chart.js';
import '../reit-financial-chart.js';

// 별도 로컬 origin에만 QA 데이터를 만든다. 운영은 공개 GET만 전달하고 모든 쓰기를 차단한다.
const root = new URL('../', import.meta.url), port = 4179;
const base = 'https://us-stock-dashboard-api.771yoyo.workers.dev';
const tickers = ['O', 'NVDA', 'JPM', 'AAPL', 'MSFT', 'TSLA'];
const companies = await Promise.all(tickers.map(async ticker => {
  const response = await fetch(`${base}/api/companies/${ticker}`);
  if (!response.ok) throw new Error(`저장값 조회 실패: ${ticker} HTTP ${response.status}`);
  return (await response.json()).company;
}));
const allowed = new Set(['index.html', 'style.css', 'app.js', 'financial-chart.js', 'reit-financial-chart.js',
  'williams-signal.js', 'tradingview-widget.js', 'fundamental-progress.js', 'fundamental-progress.css']);
const requests = [], cache = new Map();
const seed = `<script>if (!localStorage.getItem('p9b_qa_seed')) {
localStorage.setItem('stock_app_pin', '8674');
localStorage.setItem('stock_app_watchlist', ${JSON.stringify(JSON.stringify(companies.map(c => ({ ticker: c.ticker, name: c.name, strategy: ['O','JPM'].includes(c.ticker) ? 'dividend' : 'price' }))))});
localStorage.setItem('p9b_qa_seed', '1');
}</script>`;
createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const send = (status, data, type = 'application/json') => {
    response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    response.end(typeof data === 'string' ? data : JSON.stringify(data));
  };
  // QA PIN만 검증한다. 실제 운영 PIN·Secret은 읽지 않는다.
  if (url.pathname === '/api/auth/verify') return send(request.headers['x-app-pin'] === '8674' ? 200 : 401, { localPreview: true });
  // 앱의 자동 관심목록 동기화는 격리 서버 안에서만 응답하며 운영에 전달하지 않는다.
  if (url.pathname === '/api/watchlist') return send(200, { watchlist: companies.map(c => ({ ticker: c.ticker, name: c.name })) });
  if (request.method !== 'GET') return send(405, { error: 'QA 서버는 운영 쓰기를 전달하지 않습니다.' });
  if (url.pathname === '/qa/requests') return send(200, requests);
  if (url.pathname === '/api/dashboard') return send(200, { stocks: companies,
    watchlist: companies.map(c => ({ ticker: c.ticker, name: c.name, strategy: ['O', 'JPM'].includes(c.ticker) ? 'dividend' : 'price' })) });
  if (url.pathname === '/cloudflare-config.js') return send(200,
    `window.US_STOCK_PRO_CONFIG=Object.freeze({apiBaseUrl:'http://127.0.0.1:${port}'});`, 'text/javascript');
  if (/^\/api\/companies\/[A-Z]+\/specialized-metrics$/.test(url.pathname)) {
    const path = url.pathname + url.search;
    if (!cache.has(path)) cache.set(path, fetch(base + path).then(async res => ({ status: res.status, data: await res.json() })));
    try {
      const result = await cache.get(path);
      requests.push({ path, status: result.status }); return send(result.status, result.data);
    } catch { return send(502, { error: '공개 저장값 조회 실패' }); }
  }
  const ticker = url.pathname.match(/^\/api\/companies\/([A-Z]+)$/)?.[1];
  if (ticker) {
    const company = companies.find(c => c.ticker === ticker); return send(company ? 200 : 404, { company });
  }
  if (url.pathname === '/api/fundamentals/status') return send(200, { jobs: [], companies: [], totals: {} });
  const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!allowed.has(filename)) return send(404, { error: 'QA 대상이 아닙니다.' });
  try {
    let content = await readFile(new URL(filename, root), 'utf8');
    if (filename === 'index.html') content = content.replace('<script src="cloudflare-config.js">', `${seed}<script src="cloudflare-config.js">`);
    send(200, content, filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'text/javascript');
  } catch { send(500, { error: 'QA 파일 읽기 실패' }); }
}).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, productionWrite: false, tickers })));
