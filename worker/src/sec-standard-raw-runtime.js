import { extractStandardRawMetrics } from './sec-standard-raw.js';
import { assertStandardRawSchema, saveStandardRawMetrics } from './sec-standard-raw-store.js';

import { SEC_RAW_SCHEMA_VERSION, SEC_RAW_DATA_VERSION, standardRawEnabled } from './sec-raw-runtime-policy.js';
export { SEC_RAW_SCHEMA_VERSION, SEC_RAW_DATA_VERSION, standardRawEnabled } from './sec-raw-runtime-policy.js';
const retryMilliseconds = 15 * 60_000;
const safeError = 'SEC raw 처리 실패. 기존 재무는 유지되며 raw-only 재시도를 기다립니다.';

// 문자열 true gate는 sec-raw-runtime-policy에서 공유한다. 기존 full-history 활성화 의미는 바꾸지 않는다.
export async function assertRawRuntimeSchema(DB) {
  await assertStandardRawSchema(DB);
  const { results } = await DB.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name IN ('sec_raw_runtime','sec_raw_runtime_guard')`).all();
  if (results.length !== 2) throw new Error('SEC raw runtime에는 migration 0021 적용이 필요합니다.');
}

/** raw-only 큐의 공시 목록 조회 실패도 legacy 실행일/checkpoint와 독립적으로 재시도한다. */
export async function recordRawDiscoveryFailure(environment, ticker) {
  const now = new Date().toISOString();
  try {
    await environment.DB.prepare('INSERT OR IGNORE INTO sec_raw_runtime(ticker) VALUES (?)').bind(ticker).run();
    await environment.DB.prepare(`UPDATE sec_raw_runtime SET raw_status='error',raw_last_error=?,next_run_at=?,
      lease_token=NULL,lease_until=NULL WHERE ticker=? AND (lease_until IS NULL OR lease_until<=?)`)
      .bind(safeError, new Date(Date.now() + retryMilliseconds).toISOString(), ticker, now).run();
  } catch { /* DB 장애 시 기록을 강제할 수 없다. 다음 큐에서 재확인하며 성공으로 간주하지 않는다. */ }
}

/** CompanyFacts에 실제로 색인된 최신 제출 번호다. 달력 날짜로 accession을 만들지 않는다. */
export function latestRawAccession(facts) {
  let selected = null;
  for (const fact of Object.values(facts?.['us-gaap'] || {})) for (const entries of Object.values(fact.units || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) if (entry?.accn && /^10-[KQ](?:\/A)?$/.test(entry.form)
      && /^\d{4}-\d{2}-\d{2}$/.test(entry.filed || '')
      && (!selected || entry.filed > selected.filed || entry.filed === selected.filed && entry.accn > selected.accn)) {
      selected = entry;
    }
  }
  return selected?.accn || null;
}

function containsAccession(facts, accession) {
  return Object.values(facts?.['us-gaap'] || {}).some(fact => Object.values(fact.units || {})
    .some(entries => Array.isArray(entries) && entries.some(entry => entry?.accn === accession)));
}

/**
 * legacy 완료 여부와 무관하게 raw-only 실행한다. payload는 claim 후 한 번만 읽는다.
 * schema preflight는 호출자/큐 시작 시 수행한다. 실패는 raw registry에만 기록하며 legacy를 건드리지 않는다.
 */
export async function runStandardRawRuntime(environment, ticker, accession, loadFacts) {
  if (!standardRawEnabled(environment)) return { status: 'disabled' };
  if (!accession || typeof loadFacts !== 'function') throw new Error('SEC raw 실행에는 제출 번호와 원문 공급자가 필요합니다.');
  try { return await executeRawRuntime(environment, ticker, accession, loadFacts); }
  catch {
    // DB 자체가 응답하지 않으면 error 기록도 불가능하다. 성공으로 승인하지 않고 lease 만료 후 재처리한다.
    // 이 경우에도 이미 완료한 legacy job을 raw 장애 때문에 error로 바꾸지 않는다.
    return { status: 'error', error: safeError };
  }
}

async function executeRawRuntime(environment, ticker, accession, loadFacts) {
  const DB = environment.DB;
  const now = new Date().toISOString();
  await DB.prepare('INSERT OR IGNORE INTO sec_raw_runtime(ticker) VALUES (?)').bind(ticker).run();
  const state = await DB.prepare(`SELECT r.*,
    (SELECT COUNT(*) FROM sec_standard_raw_metrics m WHERE m.ticker=r.ticker) AS actual_count,
    (SELECT COUNT(*) FROM sec_standard_raw_metrics m LEFT JOIN sec_standard_raw_provenance p
      ON p.ticker=m.ticker AND p.metric_name=m.metric_name AND p.period_type=m.period_type
        AND p.period_start=m.period_start AND p.period_end=m.period_end AND p.source_fingerprint=m.source_fingerprint
      WHERE m.ticker=r.ticker AND m.availability='available' AND p.source_fingerprint IS NULL) AS source_gaps
    FROM sec_raw_runtime r WHERE ticker=?`).bind(ticker).first();
  const current = state?.raw_schema_version === SEC_RAW_SCHEMA_VERSION
    && state.raw_data_version === SEC_RAW_DATA_VERSION && state.raw_last_accession === accession;
  // 완료 registry만 믿지 않고 raw 행 수를 함께 확인한다. 비어 있으면 초기 처리한다.
  if (current && state.raw_status === 'ready' && state.record_count > 0
    && state.actual_count >= state.record_count && state.source_gaps === 0) {
    return { status: 'unchanged', records: state.record_count };
  }
  const token = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + 120_000).toISOString();
  const claimed = await DB.prepare(`UPDATE sec_raw_runtime SET raw_status='running',lease_token=?,lease_until=?,
    fence=fence+1,attempt_count=attempt_count+1,attempt_accession=?,attempt_data_version=?
    WHERE ticker=? AND (lease_until IS NULL OR lease_until<=?)
    AND (next_run_at IS NULL OR next_run_at<=? OR attempt_accession IS NOT ? OR attempt_data_version!=?)
    RETURNING fence`).bind(token, leaseUntil, accession, SEC_RAW_DATA_VERSION,
      ticker, now, now, accession, SEC_RAW_DATA_VERSION).first();
  if (!claimed) return { status: 'deferred' };
  try {
    const facts = await loadFacts();
    if (!containsAccession(facts, accession)) throw new Error('새 SEC 공시 원문 반영 대기');
    const { results: financialPeriods } = await DB.prepare(`SELECT period_type,fiscal_period_end
      FROM financial_metrics WHERE ticker=? AND source='SEC EDGAR' ORDER BY period_type,fiscal_period_end`)
      .bind(ticker).all();
    const records = extractStandardRawMetrics(facts, { financialPeriods });
    if (!records.length) throw new Error('SEC raw 저장 가능한 기간이 없습니다.');
    const available = records.filter(row => row.availability === 'available').length;
    // lease는 batch 진입 시 검증한다. transaction 중 다른 실행은 fence를 바꿀 수 없다.
    // values/provenance/완료 checkpoint를 한 번에 commit해 성공 기록만 앞서는 상태를 막는다.
    await saveStandardRawMetrics(DB, ticker, records, {
      before: [DB.prepare('INSERT INTO sec_raw_runtime_guard(ticker,lease_token,fence) VALUES (?,?,?)')
        .bind(ticker, token, claimed.fence)],
      after: [DB.prepare(`UPDATE sec_raw_runtime SET raw_schema_version=?,raw_data_version=?,raw_status='ready',
        raw_last_accession=?,raw_last_success_at=?,raw_last_error=NULL,next_run_at=NULL,
        record_count=?,available_count=?,lease_token=NULL,lease_until=NULL
        WHERE ticker=? AND lease_token=? AND fence=?`).bind(SEC_RAW_SCHEMA_VERSION, SEC_RAW_DATA_VERSION,
          accession, new Date().toISOString(), records.length, available, ticker, token, claimed.fence),
        DB.prepare('DELETE FROM sec_raw_runtime_guard WHERE ticker=?').bind(ticker)]
    });
    return { status: 'ready', records: records.length, available };
  } catch {
    // 외부 오류 문자열에 URL/credential이 들어올 수 있어 registry에는 고정된 안전한 안내만 기록한다.
    const error = safeError;
    await DB.prepare(`UPDATE sec_raw_runtime SET raw_status='error',raw_last_error=?,next_run_at=?,
      lease_token=NULL,lease_until=NULL WHERE ticker=? AND lease_token=? AND fence=?`)
      .bind(error, new Date(Date.now() + retryMilliseconds).toISOString(), ticker, token, claimed.fence).run();
    return { status: 'error', error };
  }
}
