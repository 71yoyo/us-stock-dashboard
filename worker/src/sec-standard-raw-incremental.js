import { STANDARD_RAW_METRICS, extractStandardRawMetrics } from './sec-standard-raw.js';
import { saveStandardRawMetrics } from './sec-standard-raw-store.js';
import { SEC_RAW_SCHEMA_VERSION, SEC_RAW_DATA_VERSION, standardRawEnabled } from './sec-raw-runtime-policy.js';

// 후보 JSON을 바깥 loop로 고정한다. ticker만으로 기존 전체 행을 찾은 뒤 후보를 반복 SCAN하지 않는다.
// 지표 정의가 unit/entity scope를 고정하고, 출처별 의미는 provenance fingerprint에 별도로 보존된다.
export const INCREMENTAL_REVIEW_SQL = `SELECT m.metric_name,m.period_type,m.period_start,m.period_end,
  m.metric_value AS old_value,json_extract(j.value,'$.metricValue') AS new_value,
  m.availability AS old_availability FROM json_each(?) j CROSS JOIN sec_standard_raw_metrics m
  ON m.ticker=? AND m.metric_name=json_extract(j.value,'$.metricName')
  AND m.period_type=json_extract(j.value,'$.periodType') AND m.period_start=json_extract(j.value,'$.periodStart')
  AND m.period_end=json_extract(j.value,'$.periodEnd')
  WHERE m.availability!='available' OR m.metric_value IS NOT json_extract(j.value,'$.metricValue')`;

/** available 후보의 identity/값만 한 번에 조회한다. NULL 해소와 정정은 승인 없이 overwrite하지 않는다. */
export async function lookupIncrementalReviews(DB, ticker, records) {
  const keys = records.filter(row => row.availability === 'available').map(row => ({
    metricName: row.metricName, periodType: row.periodType, periodStart: row.periodStart,
    periodEnd: row.periodEnd, metricValue: row.metricValue
  }));
  if (!keys.length) return [];
  return (await DB.prepare(INCREMENTAL_REVIEW_SQL).bind(JSON.stringify(keys), ticker).all()).results;
}

/** compact 경계를 유지하기 위해 모든 입력 fact가 요청 accession에 속하는지 먼저 검증한다. */
export function extractCompactRawRecords(facts, accession, financialPeriods = []) {
  if (!facts || typeof facts !== 'object' || !/^\d{10}-\d{2}-\d{6}$/.test(accession || '')) {
    throw new Error('SEC compact 입력/제출 번호가 유효하지 않습니다.');
  }
  const dates = new Set();
  let entries = 0;
  for (const taxonomy of Object.values(facts)) for (const fact of Object.values(taxonomy || {})) {
    for (const rows of Object.values(fact.units || {})) {
      if (!Array.isArray(rows)) throw new Error('SEC compact fact 배열이 유효하지 않습니다.');
      for (const row of rows) {
        if (row.accn !== accession) throw new Error('SEC compact 입력에는 다른 accession을 혼합할 수 없습니다.');
        dates.add(row.end); entries++;
      }
    }
  }
  if (!entries || entries > 2000) throw new Error('SEC compact 입력 범위를 확인해 주세요.');
  const records = extractStandardRawMetrics(facts, {
    financialPeriods: financialPeriods.filter(row => dates.has(row.fiscal_period_end))
  });
  if (records.some(row => !STANDARD_RAW_METRICS[row.metricName]
    || row.provenance?.sourceRefs.some(ref => ref.accession !== accession))) {
    throw new Error('SEC compact 출처/지표 의미가 일치하지 않습니다.');
  }
  return records;
}

const safeError = 'SEC compact raw 처리 실패. 기존 값은 유지되며 raw-only 재시도를 기다립니다.';

/**
 * R6I compact 경로를 유지한다. R7은 shared executor를 Queue에서 재사용하되 기본 false flag를 유지한다.
 * 이 wrapper는 초기 historical backfill을 맡지 않는다. schema preflight는 호출자가 수행한다.
 */
export async function runCompactRawRuntime(environment, ticker, accession, loadCompact, options = {}) {
  return runRawRecordRuntime(environment, ticker, accession, async () => {
    const { facts, financialPeriods } = await loadCompact();
    return extractCompactRawRecords(facts, accession, financialPeriods);
  }, options);
}

/** Node와 compact consumer가 lease/fence/원자 저장을 공유한다. Node loader는 Worker에 import하지 않는다. */
export async function runRawRecordRuntime(environment, ticker, accession, loadRecords, options = {}) {
  if (!standardRawEnabled(environment)) return { status: 'disabled' };
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker || '') || !/^\d{10}-\d{2}-\d{6}$/.test(accession || '')
    || typeof loadRecords !== 'function') throw new Error('SEC compact 실행 인자가 유효하지 않습니다.');
  const identity = options.sourceIdentity;
  if (identity && (!/^[a-f0-9]{64}$/.test(identity) || !['historical','compact'].includes(options.channel))) {
    throw new Error('SEC raw source identity가 유효하지 않습니다.');
  }
  const DB = environment.DB, now = new Date().toISOString();
  let token = null, fence = null;
  try {
    let state = await DB.prepare('SELECT * FROM sec_raw_runtime WHERE ticker=?').bind(ticker).first();
    if (!state) {
      await DB.prepare('INSERT OR IGNORE INTO sec_raw_runtime(ticker) VALUES (?)').bind(ticker).run();
      state = await DB.prepare('SELECT * FROM sec_raw_runtime WHERE ticker=?').bind(ticker).first();
    }
    // 동일 완료 공시 shortcut에만 전체 count/source-gap 검증이 필요하다. 새 공시에는 이 미사용 조회를 반복하지 않는다.
    const checkpoint = identity ? await DB.prepare(`SELECT * FROM sec_raw_payload_checkpoint
      WHERE ticker=? AND channel=?`).bind(ticker,options.channel).first() : null;
    const samePayload = !identity || checkpoint?.source_identity === identity
      && checkpoint.accession === accession && checkpoint.schema_version === 1;
    // historical source 처리 완료와 metric 검토 완료를 분리한다. compact 정정 checkpoint 정책은 유지한다.
    const processedReview = options.channel === 'historical' && options.processingCheckpoint === true
      && checkpoint?.source_identity === identity && checkpoint.accession === accession && state.raw_status === 'pending';
    if (samePayload && (state.raw_status === 'ready' && state.raw_last_accession === accession || processedReview)
      && state.raw_schema_version === SEC_RAW_SCHEMA_VERSION && state.raw_data_version === SEC_RAW_DATA_VERSION) {
      const integrity = await DB.prepare(`SELECT COUNT(*) AS actual_count,
        SUM(CASE WHEN m.availability='available' AND p.source_fingerprint IS NULL THEN 1 ELSE 0 END) AS source_gaps
        FROM sec_standard_raw_metrics m LEFT JOIN sec_standard_raw_provenance p
        ON p.ticker=m.ticker AND p.metric_name=m.metric_name AND p.period_type=m.period_type
        AND p.period_start=m.period_start AND p.period_end=m.period_end AND p.source_fingerprint=m.source_fingerprint
        WHERE m.ticker=?`).bind(ticker).first();
      if (state.record_count > 0 && integrity.actual_count >= state.record_count && integrity.source_gaps === 0) {
        return { status: 'unchanged', records: state.record_count, ...(processedReview ? { reviewPending:true } : {}) };
      }
    }
    token = crypto.randomUUID();
    const claim = await DB.prepare(`UPDATE sec_raw_runtime SET raw_status='running',lease_token=?,lease_until=?,
      fence=fence+1,attempt_count=attempt_count+1,attempt_accession=?,attempt_data_version=?
      WHERE ticker=? AND (lease_until IS NULL OR lease_until<=?)
      AND (next_run_at IS NULL OR next_run_at<=? OR attempt_accession IS NOT ? OR attempt_data_version!=? ${options.retryNow === true ? 'OR 1=1' : ''})
      RETURNING fence`).bind(token,new Date(Date.now()+120000).toISOString(),accession,
        SEC_RAW_DATA_VERSION,ticker,now,now,accession,SEC_RAW_DATA_VERSION).first();
    if (!claim) return { status: 'deferred' };
    fence = claim.fence;
    const records = await loadRecords();
    if (!records.length) throw new Error('SEC compact 저장 가능한 기간이 없습니다.');
    const reviews = await lookupIncrementalReviews(DB,ticker,records);
    const pending = reviews.length > 0 || options.strictReview === true
      && records.some(row => row.availability === 'needs_review');
    const stored = await saveStandardRawMetrics(DB,ticker,records,{ preserveExisting:true,
      before:[DB.prepare('INSERT INTO sec_raw_runtime_guard(ticker,lease_token,fence) VALUES (?,?,?)').bind(ticker,token,fence)],
      after:[DB.prepare(`UPDATE sec_raw_runtime SET raw_schema_version=?,raw_data_version=?,raw_status=?,
        raw_last_accession=CASE WHEN ? THEN raw_last_accession ELSE ? END,
        raw_last_success_at=CASE WHEN ? THEN raw_last_success_at ELSE ? END,
        raw_last_error=?,next_run_at=NULL,
        record_count=(SELECT COUNT(*) FROM sec_standard_raw_metrics WHERE ticker=?),
        available_count=(SELECT COUNT(*) FROM sec_standard_raw_metrics WHERE ticker=? AND availability='available'),
        lease_token=NULL,lease_until=NULL WHERE ticker=? AND lease_token=? AND fence=?`)
        .bind(SEC_RAW_SCHEMA_VERSION,SEC_RAW_DATA_VERSION,pending?'pending':'ready',pending?1:0,accession,
          pending?1:0,new Date().toISOString(),pending?'SEC compact 비교기간 변경 후보 검토 필요':null,
          ticker,ticker,ticker,token,fence),
        ...(identity && (!pending || options.channel === 'historical' && options.processingCheckpoint === true)
          ? [DB.prepare(`INSERT INTO sec_raw_payload_checkpoint
          (ticker,channel,accession,schema_version,source_identity) VALUES (?,?,?,1,?)
          ON CONFLICT(ticker,channel) DO UPDATE SET accession=excluded.accession,
          schema_version=excluded.schema_version,source_identity=excluded.source_identity,completed_at=CURRENT_TIMESTAMP`)
          .bind(ticker,options.channel,accession,identity)] : []),
        DB.prepare('DELETE FROM sec_raw_runtime_guard WHERE ticker=?').bind(ticker)] });
    return { status:pending?'pending_review':'ready',...stored,reviewCount:reviews.length,
      valueCorrections:reviews.filter(row=>row.old_availability==='available').length };
  } catch {
    if (token && fence !== null) {
      try { await DB.prepare(`UPDATE sec_raw_runtime SET raw_status='error',raw_last_error=?,next_run_at=?,
        lease_token=NULL,lease_until=NULL WHERE ticker=? AND lease_token=? AND fence=?`)
        .bind(safeError,new Date(Date.now()+15*60000).toISOString(),ticker,token,fence).run(); }
      catch { /* 기록 장애 때는 lease 만료 후 재시도하며 성공으로 승인하지 않는다. */ }
    }
    return { status:'error',error:safeError };
  }
}
