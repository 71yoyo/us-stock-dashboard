import { ensureFundamentalStore } from './fundamental-store.js';
import { syncProfile, syncFinancialsFromSec, syncDividends, syncDividendsFromSec } from './fmp-sync.js';

const kinds = ['profile', 'financials', 'dividends'];
const labels = { profile: '회사 정보', financials: '재무', dividends: '배당' };
const day = 86400000;
const after = milliseconds => new Date(Date.now() + milliseconds).toISOString();

/** 최초 1회 모든 목록을 등록하고, 신규 종목만 추가한다. 완료 작업은 다시 대기 상태로 만들지 않는다. */
async function seedJobs(environment) {
  await ensureFundamentalStore(environment);
  await environment.DB.batch(kinds.map(kind => environment.DB.prepare(`INSERT OR IGNORE INTO fundamental_jobs(ticker, kind)
    SELECT ticker, ? FROM user_watchlist WHERE user_id = 'primary'`).bind(kind)));
}

function readDetails(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

export async function fundamentalStatus(environment) {
  await seedJobs(environment);
  const jobs = await environment.DB.prepare(`SELECT j.* FROM fundamental_jobs j
    JOIN user_watchlist w ON w.ticker = j.ticker AND w.user_id = 'primary'
    ORDER BY w.display_order, j.kind`).all();
  const rows = jobs.results.map(job => ({
    ticker: job.ticker, kind: job.kind, label: labels[job.kind],
    status: job.status === 'running' && job.lease_until < new Date().toISOString() ? 'pending' : job.status,
    checkedAt: job.checked_at, nextRunAt: job.next_run_at, details: readDetails(job.details), error: job.error
  }));
  const summary = Object.fromEntries(kinds.map(kind => {
    const group = rows.filter(row => row.kind === kind);
    return [kind, { total: group.length,
      processed: group.filter(row => row.checkedAt).length,
      stored: group.filter(row => ['ready', 'partial'].includes(row.status)).length,
      pending: group.filter(row => ['pending', 'running'].includes(row.status)).length }];
  }));
  return { summary, jobs: rows, checkedAt: new Date().toISOString(), scope: kinds };
}

async function latestFiling(environment, ticker) {
  const company = await environment.DB.prepare('SELECT cik FROM companies WHERE ticker = ?').bind(ticker).first();
  const cik = String(company?.cik || '').replace(/\D/g, '');
  if (!cik) throw new Error('회사 식별번호(CIK) 수집 대기');
  const response = await fetch(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`, {
    headers: { 'User-Agent': environment.SEC_USER_AGENT || 'US Stock Pro https://github.com/71yoyo/us-stock-dashboard', Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`SEC 공시 목록 HTTP ${response.status}`);
  const recent = (await response.json()).filings?.recent;
  const index = recent?.form?.findIndex(form => ['10-K', '10-Q', '10-K/A', '10-Q/A'].includes(form)) ?? -1;
  if (index < 0) throw new Error('지원되는 10-K·10-Q 공시가 없습니다. ETF·해외기업은 별도 공급자가 필요합니다.');
  return { accession: recent.accessionNumber[index], reportDate: recent.reportDate[index] };
}

async function financialTask(environment, ticker, previous) {
  const filing = await latestFiling(environment, ticker);
  const saved = await environment.DB.prepare('SELECT accession FROM sec_filing_checks WHERE ticker = ?').bind(ticker).first();
  if (saved?.accession === filing.accession && previous.annualCount) return previous;
  const details = await syncFinancialsFromSec(environment, ticker);
  // 공시 목록이 원문보다 먼저 갱신될 수 있다. 해당 accession이 없으면 다음날 다시 읽는다.
  const facts = environment.secFacts.get(ticker);
  const indexed = Object.values(facts?.['us-gaap'] || {}).some(fact =>
    Object.values(fact.units || {}).some(rows => rows.some(row => row.accn === filing.accession)));
  if (!indexed) throw new Error('새 공시 원문 반영 대기: 다음날 재확인합니다. 기존 저장값은 유지됩니다.');
  await environment.DB.prepare(`INSERT INTO sec_filing_checks(ticker, accession, checked_at, report_date)
    VALUES (?, ?, ?, ?) ON CONFLICT(ticker) DO UPDATE SET accession=excluded.accession,
    checked_at=excluded.checked_at, report_date=excluded.report_date`)
    .bind(ticker, filing.accession, new Date().toISOString(), filing.reportDate).run();
  const coverage = await environment.DB.prepare(`SELECT MAX(fiscal_period_end) AS latestPeriod,
    SUM(CASE WHEN revenue IS NOT NULL AND net_income IS NOT NULL THEN 1 ELSE 0 END) AS coreRows
    FROM financial_metrics WHERE ticker = ? AND period_type = 'quarterly'`).bind(ticker).first();
  return { ...details, ...coverage, accession: filing.accession,
    note: 'SEC 제공 범위 저장. PER·PEG·ROIC 등 미확보 지표는 완료로 간주하지 않습니다.' };
}

async function dividendTask(environment, ticker) {
  let secDetails = null;
  let secError = null;
  // 같은 종목의 재무와 배당은 요청 안에서 Company Facts 한 번만 다운로드한다.
  try { secDetails = await syncDividendsFromSec(environment, ticker); }
  catch (error) { secError = error.message; }
  try {
    const fmp = await syncDividends(environment, ticker);
    return { ...secDetails, ...fmp, note: secDetails ? 'FMP 이벤트 + SEC 연간·분기 이력' : 'FMP 이벤트 저장, SEC 배당 이력 미확보' };
  } catch (error) {
    if (secDetails) return { ...secDetails, note: `배당 집계 저장. 다음 배당일 미확보. ${error.message}` };
    // 빈 응답은 무배당의 증거가 아니다. 무배당으로 확정하거나 0을 저장하지 않는다.
    throw new Error(`배당 정보 미확보: ${secError || ''}; ${error.message}`);
  }
}

export function classifyFundamental(kind, details) {
  if (kind === 'profile') return 'ready';
  if (kind === 'financials') return 'partial'; // 이력과 비율의 부분 제공을 화면에서 구분한다.
  return 'partial'; // 배당성장 최대 연수·미래 일정은 별도 검증이 필요하다.
}

/** 요청/예약 실행이 겹쳐도 같은 작업은 2분 임대로 한 번만 수행한다. */
async function executeJob(environment, job) {
  const now = new Date().toISOString();
  const token = crypto.randomUUID();
  const claimed = await environment.DB.prepare(`UPDATE fundamental_jobs SET status='running', lease_token=?, lease_until=?
    WHERE ticker=? AND kind=? AND (lease_until IS NULL OR lease_until < ?)
      AND (next_run_at IS NULL OR next_run_at <= ?) RETURNING ticker`)
    .bind(token, after(120000), job.ticker, job.kind, now, now).first();
  if (!claimed) return { ticker: job.ticker, kind: job.kind, status: 'skipped' };
  let status, details = readDetails(job.details), error = null;
  let nextRun = after(job.kind === 'profile' ? 30 * day : day);
  try {
    if (job.kind === 'profile') {
      const existing = await environment.DB.prepare('SELECT cik, updated_at FROM companies WHERE ticker=?').bind(job.ticker).first();
      if (!existing?.cik || new Date(existing.updated_at.replace(' ', 'T') + 'Z').getTime() < Date.now() - 30 * day) {
        await syncProfile(environment, job.ticker);
      }
      details = { source: 'FMP' };
    } else if (job.kind === 'financials') {
      details = await financialTask(environment, job.ticker, details);
    } else details = await dividendTask(environment, job.ticker);
    status = classifyFundamental(job.kind, details);
  } catch (failure) {
    error = String(failure.message || failure).slice(0, 700);
    status = 'error';
    // 권한 제한/원문 미제공은 느리게, 일시적 네트워크 오류는 15분 뒤 재시도한다.
    nextRun = after(/402|429|예산|미확보|없습니다|다음날|지원되는/.test(error) ? day : /403/.test(error) ? day / 4 : 900000);
  }
  await environment.DB.prepare(`UPDATE fundamental_jobs SET status=?, details=?, error=?, checked_at=?,
    next_run_at=?, lease_until=NULL, lease_token=NULL WHERE ticker=? AND kind=? AND lease_token=?`)
    .bind(status, JSON.stringify(details), error, new Date().toISOString(), nextRun, job.ticker, job.kind, token).run();
  return { ticker: job.ticker, kind: job.kind, status, details, error };
}

export async function runFundamentalBatch(environment, requestedTicker = null) {
  const scope = { ...environment, secFacts: new Map() };
  await seedJobs(scope);
  const now = new Date().toISOString();
  const due = await scope.DB.prepare(`SELECT j.*, w.display_order FROM fundamental_jobs j
    JOIN user_watchlist w ON w.ticker=j.ticker AND w.user_id='primary'
    WHERE (j.next_run_at IS NULL OR j.next_run_at <= ?)
      AND (j.lease_until IS NULL OR j.lease_until < ?)
      AND (? IS NULL OR j.ticker=?)
    ORDER BY CASE WHEN j.checked_at IS NULL THEN 0 ELSE 1 END, j.checked_at, w.display_order`)
    .bind(now, now, requestedTicker, requestedTicker).all();
  const tickers = [...new Set(due.results.map(job => job.ticker))].slice(0, 2);
  const results = [];
  const started = Date.now();
  for (const ticker of tickers) {
    const token = crypto.randomUUID();
    const lock = await scope.DB.prepare(`INSERT INTO fundamental_locks(ticker, token, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at
      WHERE expires_at < ? RETURNING ticker`).bind(ticker, token, after(120000), new Date().toISOString()).first();
    if (!lock) continue;
    try {
      for (const kind of kinds) {
        const job = due.results.find(item => item.ticker === ticker && item.kind === kind);
        if (!job || Date.now() - started > 20000) continue;
        results.push(await executeJob(scope, job));
      }
    } finally {
      scope.secFacts.delete(ticker);
      await scope.DB.prepare('DELETE FROM fundamental_locks WHERE ticker=? AND token=?').bind(ticker, token).run();
    }
  }
  return { results, status: await fundamentalStatus(scope) };
}

export async function fundamentalDetails(environment, ticker) {
  await ensureFundamentalStore(environment);
  const [jobs, history] = await environment.DB.batch([
    environment.DB.prepare('SELECT kind, status, details, error FROM fundamental_jobs WHERE ticker=?').bind(ticker),
    environment.DB.prepare(`SELECT period_type AS periodType, period_end AS periodEnd, amount, source
      FROM dividend_periods WHERE ticker=? ORDER BY period_end DESC`).bind(ticker)
  ]);
  return { collection: jobs.results.map(job => ({ ...job, details: readDetails(job.details) })), dividendHistory: history.results };
}
