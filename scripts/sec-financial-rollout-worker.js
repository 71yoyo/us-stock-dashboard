import { syncFinancialsFromSec } from '../worker/src/fmp-sync.js';

const metrics = ['revenue', 'operating_income', 'net_income', 'eps', 'free_cash_flow', 'roe', 'gross_margin', 'operating_margin'];
const response = (status, body) => new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
// 사전 확인한 공식 SEC 원본만 요청 범위 메모리에 보관한다. 운영 DB에는 아직 쓰지 않는다.
const verifiedFacts = new Map();

/** 공개 Worker가 아닌 wrangler dev --remote 전용이다. 프리뷰 인증 채널로만 접근하고 Cron은 없다. */
// 단계별 검증 도구가 고정 허용 목록만 바꿔 재사용한다. 운영 재무 계산 경로는 그대로 유지한다.
export function createSecFinancialRolloutWorker(permittedTickers) {
  const permitted = new Set(permittedTickers);
  return {
  async fetch(request, environment) {
    const path = new URL(request.url).pathname;
    const validAgent = typeof environment.SEC_USER_AGENT === 'string'
      && /[^\s@]+@[^\s@]+\.[^\s@]+/.test(environment.SEC_USER_AGENT);
    if (!validAgent) return response(503, { blocker: 'SEC USER AGENT BLOCKER', configured: false });
    if (request.method === 'GET' && path === '/sec-preflight') {
      // 운영 Secret을 상속한 Cloudflare 런타임에서 NVDA를 한 번만 확인한다. DB 쓰기와 응답 본문 출력은 없다.
      try {
        const upstream = await fetch('https://data.sec.gov/api/xbrl/companyfacts/CIK0001045810.json', {
          headers: { 'User-Agent': environment.SEC_USER_AGENT, Accept: 'application/json' },
          // Workers 지원 옵션으로 리다이렉트는 받되 따라가지 않는다. Location 전체도 기록하지 않는다.
          redirect: 'manual', signal: AbortSignal.timeout(20000)
        });
        const status = upstream.status;
        const contentType = upstream.headers.get('content-type') || '';
        const diagnostic = { secStatus: status, secContentType: contentType, configured: true, databaseWrite: false };
        if (status >= 300 && status < 400) {
          await upstream.body?.cancel();
          return response(502, { ...diagnostic, error: 'SEC_PREFLIGHT_REDIRECT_ERROR' });
        }
        if (status !== 200) {
          await upstream.body?.cancel();
          return response(502, { ...diagnostic, error: 'SEC_PREFLIGHT_HTTP_ERROR' });
        }
        if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
          await upstream.body?.cancel();
          return response(502, { ...diagnostic, error: 'SEC_PREFLIGHT_NON_JSON' });
        }
        let payload;
        try { payload = await upstream.json(); }
        catch { return response(502, { ...diagnostic, error: 'SEC_PREFLIGHT_INVALID_JSON' }); }
        if (!payload?.facts?.['us-gaap']) return response(502, { ...diagnostic, error: 'SEC_PREFLIGHT_SCHEMA_ERROR' });
        // 공식 SEC 원본을 메모리에만 보관해 NVDA 재처리 때 동일 응답을 재사용한다. 외부 비교값은 없다.
        verifiedFacts.set('NVDA', { facts: payload.facts, verifiedAt: Date.now() });
        return response(200, diagnostic);
      } catch (error) {
        return response(502, { secStatus: null, error: 'SEC_PREFLIGHT_NETWORK_ERROR', errorType: error.name, databaseWrite: false });
      }
    }
    const match = path.match(/^\/sec-reprocess\/([A-Z]+)$/);
    if (request.method !== 'POST' || !match || !permitted.has(match[1])) return response(404, { error: '허용된 단일 종목 요청만 가능합니다.' });
    const ticker = match[1];
    const priorJob = await environment.DB.prepare("SELECT details FROM fundamental_jobs WHERE ticker=? AND kind='financials'").bind(ticker).first();
    let previous = {};
    try { previous = JSON.parse(priorJob?.details || '{}'); } catch { /* 이전 요약 손상은 SEC 원본 검증을 막지 않는다. */ }
    if (previous.metadataVersion === 1) return response(409, { error: '이미 출처 버전 1로 처리됐습니다. 재시도하지 않습니다.', ticker });
    const before = (await environment.DB.prepare('SELECT * FROM financial_metrics WHERE ticker=? ORDER BY period_type,fiscal_period_end DESC').bind(ticker).all()).results;
    try {
      // 회사·일봉·시세·배당 수집은 호출하지 않는다. 실제 운영 D1의 해당 종목 SEC 재무만 처리한다.
      const cached = verifiedFacts.get(ticker);
      const secFacts = cached && Date.now() - cached.verifiedAt < 10 * 60_000
        ? new Map([[ticker, cached.facts]]) : new Map();
      const result = await syncFinancialsFromSec({ ...environment, secFacts }, ticker);
      verifiedFacts.delete(ticker);
      const after = (await environment.DB.prepare('SELECT * FROM financial_metrics WHERE ticker=? ORDER BY period_type,fiscal_period_end DESC').bind(ticker).all()).results;
      const changes = before.flatMap(row => {
        const current = after.find(item => item.period_type === row.period_type && item.fiscal_period_end === row.fiscal_period_end);
        return metrics.filter(metric => !current || row[metric] !== current[metric]).map(metric => ({ period: row.fiscal_period_end,
          type: row.period_type, metric, before: row[metric], after: current?.[metric] ?? null }));
      });
      const coverage = (await environment.DB.prepare(`SELECT period_type,COUNT(*) AS total,
        SUM(fiscal_year IS NOT NULL) AS fiscalYear,SUM(fiscal_period IS NOT NULL) AS fiscalPeriod,
        SUM(period_start IS NOT NULL) AS periodStart FROM financial_metrics WHERE ticker=? GROUP BY period_type`).bind(ticker).all()).results;
      const recent = ['annual', 'quarterly'].flatMap(type => after.filter(row => row.period_type === type).slice(0, type === 'annual' ? 2 : 4));
      const latest = after.find(row => row.period_type === 'quarterly')?.fiscal_period_end;
      const sources = (await environment.DB.prepare('SELECT * FROM financial_metric_provenance WHERE ticker=? AND period_type=? AND fiscal_period_end=?')
        .bind(ticker, 'quarterly', latest).all()).results;
      const provenance = sources.filter(row => metrics.includes(row.metric_name)).map(row => ({ metric: row.metric_name,
        calculationType: row.calculation_type, tag: row.sec_tag, form: row.form, accession: row.accession_number,
        filed: row.filed_date, unit: row.unit, refCount: JSON.parse(row.source_refs_json).length }));
      if (!changes.length && priorJob) {
        // 명시적으로 검증한 종목만 버전 완료로 표시한다. 전역 큐·다른 종목 작업은 수정하지 않는다.
        await environment.DB.prepare("UPDATE fundamental_jobs SET details=? WHERE ticker=? AND kind='financials'")
          .bind(JSON.stringify({ ...previous, ...result }), ticker).run();
      }
      return response(changes.length ? 409 : 200, { ticker, secStatus: 200, result, coverage, recent, provenance,
        changes, comparedRows: before.length, fullBackfill: false });
    } catch (error) {
      // 비밀값이 포함될 가능성이 있는 원본 예외 대신 SEC 상태와 오류 종류만 보고한다.
      return response(502, { ticker, blocker: 'PRODUCTION BLOCKER', secStatus: Number(String(error.message).match(/HTTP (\d{3})/)?.[1]) || null,
        errorType: error.name, message: 'SEC 재처리 실패 · 다른 종목을 실행하지 마세요.' });
    }
  }
  };
}

// Phase 1.6A의 접근 범위와 기존 테스트를 그대로 보존한다.
export default createSecFinancialRolloutWorker(['NVDA', 'AAPL', 'MSFT', 'JPM', 'O']);
