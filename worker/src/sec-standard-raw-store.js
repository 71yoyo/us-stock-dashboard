import { STANDARD_RAW_METRICS } from './sec-standard-raw.js';

const TYPES = ['instant','annual','quarterly','ytd'];
const CALCULATIONS = ['direct','ytd_difference','fy_minus_9m','derived'];

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}

/** 운영 migration 전 실수로 경로가 활성화되면 기존 재무 쓰기 전에 안전하게 중단한다. */
export async function assertStandardRawSchema(DB) {
  const rows = await DB.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name IN ('sec_standard_raw_metrics','sec_standard_raw_provenance')`).all();
  if (rows.results.length !== 2) throw new Error('SEC 표준 raw 저장에는 migration 0020 로컬 적용이 필요합니다.');
}

function validateRecord(record) {
  if (!record || typeof record !== 'object') throw new Error('SEC raw 저장 행이 유효하지 않습니다.');
  const definition = STANDARD_RAW_METRICS[record.metricName];
  if (!definition || !TYPES.includes(record.periodType) || record.valueKind !== definition.kind
    || record.unit !== definition.unit || record.entityScope !== definition.scope
    || !validDate(record.periodEnd)
    || (record.periodType === 'instant' ? record.periodStart !== '' || definition.kind !== 'point_in_time'
      : !validDate(record.periodStart) || record.periodStart > record.periodEnd
        || definition.kind === 'point_in_time')) throw new Error('SEC 표준 raw 지표/기간/범위가 유효하지 않습니다.');
  if (!['available','missing','needs_review'].includes(record.availability)) throw new Error('SEC raw 상태가 유효하지 않습니다.');
  if (record.availability !== 'available') {
    if (record.metricValue !== null || record.provenance !== null) throw new Error('미확보 raw 값은 NULL이어야 합니다.');
    return;
  }
  const source = record.provenance;
  if (!Number.isFinite(record.metricValue) || source?.metricValue !== record.metricValue
    || source.unit !== record.unit || !CALCULATIONS.includes(source.calculationType)
    || !source.sourceRefs?.length || source.sourceRefs.some(ref => !ref.tag || !ref.accession
      || !ref.form || !ref.filed || !ref.end || ref.unit !== record.unit || !Number.isFinite(ref.value))
    || source.calculationDetails?.entityScope !== record.entityScope) {
    throw new Error('SEC raw 값에 완전한 source provenance가 필요합니다.');
  }
  if (definition.kind === 'period_average' && (record.periodType === 'ytd' || source.calculationType !== 'direct')) {
    throw new Error('가중평균 주식 수는 직접 연간/standalone 분기 값만 저장할 수 있습니다.');
  }
}

async function fingerprint(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 기존 provenance FK는 financial_metrics의 annual/quarterly에 묶여 있다.
 * 필드 이름을 겹쳐 overwrite하지 않고 새 이력 테이블에 원본과 파생 입력을 append-only로 남긴다.
 * JSON bulk bind를 사용해 추가 SQL 수를 제한하며 모든 chunk를 하나의 D1 batch로 원자 실행한다.
 */
export async function saveStandardRawMetrics(DB, ticker, records) {
  if (typeof ticker !== 'string' || !/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker)) throw new Error('SEC raw 종목코드가 유효하지 않습니다.');
  if (!Array.isArray(records)) throw new Error('SEC raw 저장 자료는 행 배열이어야 합니다.');
  const identities = new Set();
  const normalized = [];
  for (const record of records) {
    validateRecord(record);
    const identity = JSON.stringify([record.metricName,record.periodType,record.periodStart,record.periodEnd]);
    if (identities.has(identity)) throw new Error('SEC raw 중복 기간 identity가 있습니다.');
    identities.add(identity);
    const sourceFingerprint = record.provenance ? await fingerprint(record.provenance) : null;
    normalized.push({ ...record, sourceFingerprint });
  }
  const statements = [];
  // 256행 단위로 출처 JSON 크기를 제한한다. 동기화 한 회는 최대 10년/40분기의 기간 창만 추출한다.
  for (let offset = 0; offset < normalized.length; offset += 256) {
    const rows = JSON.stringify(normalized.slice(offset, offset + 256));
    statements.push(DB.prepare(`INSERT INTO sec_standard_raw_metrics
      (ticker,metric_name,period_type,period_start,period_end,value_kind,entity_scope,unit,
       metric_value,availability,reason,fiscal_year,fiscal_period,source_fingerprint)
      SELECT ?,json_extract(value,'$.metricName'),json_extract(value,'$.periodType'),
        json_extract(value,'$.periodStart'),json_extract(value,'$.periodEnd'),json_extract(value,'$.valueKind'),
        json_extract(value,'$.entityScope'),json_extract(value,'$.unit'),json_extract(value,'$.metricValue'),
        json_extract(value,'$.availability'),json_extract(value,'$.reason'),json_extract(value,'$.fiscalYear'),
        json_extract(value,'$.fiscalPeriod'),json_extract(value,'$.sourceFingerprint')
      FROM json_each(?) WHERE 1
      ON CONFLICT(ticker,metric_name,period_type,period_start,period_end) DO UPDATE SET
        metric_value=excluded.metric_value,availability=excluded.availability,reason=excluded.reason,
        fiscal_year=excluded.fiscal_year,fiscal_period=excluded.fiscal_period,
        source_fingerprint=excluded.source_fingerprint,updated_at=CURRENT_TIMESTAMP
      WHERE sec_standard_raw_metrics.source_fingerprint IS NOT excluded.source_fingerprint
        OR sec_standard_raw_metrics.availability IS NOT excluded.availability
        OR sec_standard_raw_metrics.reason IS NOT excluded.reason
        OR sec_standard_raw_metrics.fiscal_year IS NOT excluded.fiscal_year
        OR sec_standard_raw_metrics.fiscal_period IS NOT excluded.fiscal_period`).bind(ticker, rows));
    statements.push(DB.prepare(`INSERT INTO sec_standard_raw_provenance
      (ticker,metric_name,period_type,period_start,period_end,source_fingerprint,metric_value,
       sec_tag,form,accession_number,filed_date,source_start,source_end,unit,calculation_type,
       source_refs_json,calculation_details_json)
      SELECT ?,json_extract(value,'$.metricName'),json_extract(value,'$.periodType'),
        json_extract(value,'$.periodStart'),json_extract(value,'$.periodEnd'),json_extract(value,'$.sourceFingerprint'),
        json_extract(value,'$.metricValue'),json_extract(value,'$.provenance.secTag'),
        json_extract(value,'$.provenance.form'),json_extract(value,'$.provenance.accessionNumber'),
        json_extract(value,'$.provenance.filedDate'),json_extract(value,'$.provenance.sourceStart'),
        json_extract(value,'$.provenance.sourceEnd'),json_extract(value,'$.unit'),
        json_extract(value,'$.provenance.calculationType'),json_extract(value,'$.provenance.sourceRefs'),
        json_extract(value,'$.provenance.calculationDetails')
      FROM json_each(?) WHERE json_extract(value,'$.availability')='available'
      ON CONFLICT(ticker,metric_name,period_type,period_start,period_end,source_fingerprint) DO NOTHING`).bind(ticker, rows));
  }
  if (statements.length) await DB.batch(statements);
  return { records: normalized.length, available: normalized.filter(row => row.availability === 'available').length,
    missing: normalized.filter(row => row.availability === 'missing').length,
    needsReview: normalized.filter(row => row.availability === 'needs_review').length };
}

/** 내부 검증용 조회다. public HTTP contract나 UI에는 연결하지 않는다. */
export async function queryStandardRawMetrics(DB, ticker, periodType) {
  if (!TYPES.includes(periodType)) throw new Error('SEC raw 조회 기간이 유효하지 않습니다.');
  const { results } = await DB.prepare(`SELECT m.*,p.sec_tag,p.form,p.accession_number,p.filed_date,
    p.source_start,p.source_end,p.calculation_type,p.source_refs_json,p.calculation_details_json
    FROM sec_standard_raw_metrics m LEFT JOIN sec_standard_raw_provenance p
      ON p.ticker=m.ticker AND p.metric_name=m.metric_name AND p.period_type=m.period_type
      AND p.period_start=m.period_start AND p.period_end=m.period_end
      AND p.source_fingerprint=m.source_fingerprint
    WHERE m.ticker=? AND m.period_type=? ORDER BY m.period_end,m.period_start,m.metric_name`)
    .bind(ticker, periodType).all();
  return results.map(row => ({ ...row, sourceRefs: row.source_refs_json ? JSON.parse(row.source_refs_json) : [],
    calculationDetails: row.calculation_details_json ? JSON.parse(row.calculation_details_json) : null }));
}
