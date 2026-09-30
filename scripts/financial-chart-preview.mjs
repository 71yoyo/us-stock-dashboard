import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 로컬 UI 검증 전용: 운영에서는 공개 company GET만 읽는다. 쓰기·수집 요청은 절대 전달하지 않는다.
const base = new URL('../', import.meta.url);
const tickers = ['NVDA', 'AAPL', 'MSFT', 'JPM', 'O', 'TSLA'];
const companies = await Promise.all(tickers.map(async ticker => {
  const response = await fetch(`https://us-stock-dashboard-api.771yoyo.workers.dev/api/companies/${ticker}`);
  if (!response.ok) throw new Error(`${ticker} 저장 이력 조회 실패: HTTP ${response.status}`);
  const { company } = await response.json();
  if (!Array.isArray(company?.financials)) throw new Error(`${ticker} financials 미확보`);
  return company;
}));
const allowedFiles = new Set(['index.html', 'style.css', 'financial-chart.js', 'app.js',
  'williams-signal.js', 'tradingview-widget.js', 'fundamental-progress.js', 'fundamental-progress.css']);
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:4173');
  const send = (status, content, type = 'application/json') => {
    response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    response.end(typeof content === 'string' ? content : JSON.stringify(content));
  };
  // 앱의 기존 로컬 PIN fallback을 검증한다. 테스트 서버는 인증 Secret을 갖지 않는다.
  if (url.pathname === '/api/auth/verify') return send(503, { localPreview: true });
  if (request.method !== 'GET') return send(405, { error: '로컬 검증에서는 운영 쓰기를 차단합니다.' });
  if (url.pathname === '/cloudflare-config.js') {
    return send(200, 'window.US_STOCK_PRO_CONFIG = Object.freeze({ apiBaseUrl: "http://127.0.0.1:4173" });', 'text/javascript');
  }
  if (url.pathname === '/api/dashboard') return send(200, {
    watchlist: companies.map(company => ({ ticker: company.ticker, name: company.name,
      strategy: ['JPM', 'O'].includes(company.ticker) ? 'dividend' : 'price' })), stocks: companies
  });
  const ticker = url.pathname.match(/^\/api\/companies\/([A-Z]+)$/)?.[1];
  if (ticker) {
    const company = companies.find(item => item.ticker === ticker);
    return send(company ? 200 : 404, { company });
  }
  if (url.pathname === '/api/fundamentals/status') return send(200, { jobs: [], companies: [], totals: {}, localPreview: true });
  const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!allowedFiles.has(filename)) return send(404, { error: '로컬 검증 대상 파일이 아닙니다.' });
  try { send(200, await readFile(new URL(filename, base), 'utf8'), mime[filename.slice(filename.lastIndexOf('.'))]); }
  catch { send(500, { error: '로컬 파일을 읽지 못했습니다.' }); }
});
server.listen(4173, '127.0.0.1', () => console.log(JSON.stringify({ localPreview: 'http://127.0.0.1:4173',
  productionWrite: false, source: '운영 공개 GET의 메모리 스냅샷', root: fileURLToPath(base),
  companies: companies.map(company => ({ ticker: company.ticker,
    annual: company.financials.filter(row => row.periodType === 'annual').length,
    quarterly: company.financials.filter(row => row.periodType === 'quarterly').length })) })));
