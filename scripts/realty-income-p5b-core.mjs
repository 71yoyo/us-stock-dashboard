import { pdfFingerprint, excerptHash, FORMATS } from '../worker/src/reit/realty-income-document-formats.js';
import { parseRealtyIncomePdfText } from '../worker/src/reit/realty-income-pdf-parser.js';
import { assertMetricRecord, metricRecordKey } from '../worker/src/specialized-metrics.js';

export const FINAL_STATUSES = ['VERIFIED_PARSED', 'PARSED', 'NEEDS_REVIEW', 'UNKNOWN_FORMAT', 'WRONG_ISSUER', 'SOURCE_UNAVAILABLE', 'PARSER_ERROR'];
const success = row => ['PARSED', 'VERIFIED_PARSED'].includes(row.final_status);
const requireAudit = (condition, message) => { if (!condition) throw new Error(message); };

export function verifyInventory(inventory) {
  requireAudit(inventory.length === 40, 'P5B는 정확히 40개 inventory만 허용합니다.');
  requireAudit(new Set(inventory.map(row => `${row.year}-Q${row.quarter}`)).size === 40, '중복 inventory key');
  requireAudit(new Set(inventory.map(row => row.source_url)).size === 40, '중복 inventory URL');
  for (const row of inventory) {
    const url = new URL(row.source_url);
    requireAudit(row.year >= 2016 && row.year <= 2025 && [1, 2, 3, 4].includes(row.quarter)
      && url.protocol === 'https:' && url.hostname === 'www.realtyincome.com' && !url.search
      && !url.username && !url.password && row.issuer === 'Realty Income Corporation' && row.CIK === '0000726728', 'inventory 기간/공식 issuer 오류');
  }
  return inventory;
}

export function tablePair(inspection) {
  const tables = inspection.candidate_tables || [];
  // earnings 요약/appendix와 supplemental 조정표를 혼합하지 않는다. 반복 조정표가 모호하면 중단한다.
  const supplemental = tables.filter(page => /Q[1-4] \d{4} Supplemental Operating & Financial Data/.test(page.text));
  const heading = page => page.text.split('\n').slice(0, 2).join(' ');
  const ffo = supplemental.filter(page => /^(?:\(1\)\s*)?(?:Funds From Operations\s*\((?:FFO|1)\)|FFO and Normalized FFO)/i.test(heading(page)));
  const affo = supplemental.filter(page => /^(?:\(1\)\s*)?(?:Adjusted Funds From Operations\s*\((?:AFFO|1)\)|AFFO\b)/i.test(heading(page)));
  requireAudit(ffo.length === 1 && affo.length === 1 && ffo[0] !== affo[0], 'FFO/AFFO supplemental 표 선택이 모호합니다.');
  return { ffo: ffo[0], affo: affo[0] };
}

export function unitAudit(pair) {
  const units = Object.values(pair).map(page => page.text.split('\n').slice(0, 4).find(line => /\bthousands\b|\bmillions\b/.test(line)) ?? null);
  const supported = units.every(unit => /^\((?:dollars )?in thousands\s*, except per share (?:amounts|and share count data)\)$/.test(unit));
  return { raw_currency: units.every(unit => /(?:dollars|USD|in thousands)/.test(unit)) ? 'USD' : null,
    raw_unit_labels: units, raw_unit: supported ? 'USD thousand' : null, multiplier: supported ? 1000 : null,
    per_share_unit: supported ? 'USD/share' : null,
    weighted_share_count_unit: supported ? units.map(unit => /dollars in thousands|and share count data/.test(unit) ? 'shares' : 'shares thousand') : null,
    supported };
}

export function basisDisclosure(pair) {
  // 원문에 어떤 basis 행이 공시됐는지만 조사한다. 숫자 추출·정규화·adapter 승인과는 별개다.
  const metrics = {};
  for (const [code, label, page] of [['FFO', 'FFO', pair.ffo], ['NORMALIZED_FFO', 'Normalized FFO', pair.ffo], ['AFFO', 'AFFO', pair.affo]]) {
    const lines = page.text.split('\n');
    // 한 줄로 이어진 행과 label 다음 줄에 값이 놓인 행을 공시 여부 조사에서 구별한다.
    const total = new RegExp(`^${label} available to common stockholders(?:\\s+\\$?\\s*[-(\\d]|$)`);
    const diluted = new RegExp(`^Diluted ${label}\\s+\\$?\\s*[-(\\d]`);
    const heading = new RegExp(`^${label} per common share\\b`);
    const index = lines.findIndex(line => heading.test(line));
    const share = index < 0 ? [] : lines.slice(index, index + 4);
    const joint = share.some(line => /basic and diluted/i.test(line));
    metrics[code] = {
      'total/not_applicable': lines.some(line => total.test(line)) ? 'reported' : 'not_reported',
      'total/diluted': lines.some(line => diluted.test(line)) ? 'reported' : 'not_reported',
      'per_share/basic': joint || share.some(line => /^Basic\s+\$?\s*[-(\d]/i.test(line)) ? 'reported' : 'not_reported',
      'per_share/diluted': joint || share.some(line => /^Diluted\s+\$?\s*[-(\d]/i.test(line)) ? 'reported' : 'not_reported'
    };
  }
  return metrics;
}

// 실제 cache와 최소 offline fixture가 같은 발췌/출처 생성 경로를 사용한다.
export function buildAuditExcerpt(inspection, pair = tablePair(inspection)) {
  return { identity_text: inspection.identity_text, document_title: inspection.document_title,
    pages: Object.values(pair).map(page => {
      const lines = page.text.split('\n'), start = lines.findIndex(line => /Three months ended/i.test(line));
      let table = start >= 2 ? [...lines.slice(0, 2), ...lines.slice(start)].join('\n') : page.text;
      table = table.replace(/^FUNDS FROM OPERATIONS \(FFO\)/, 'Funds From Operations (FFO)')
        .replace(/^ADJUSTED FUNDS FROM OPERATIONS \(AFFO\)/, 'Adjusted Funds From Operations (AFFO)')
        .replace(/^Funds From Operations\s*\(1\)/, 'Funds From Operations (FFO) (1)')
        .replace(/^Adjusted Funds From Operations\s*\(1\)/, 'Adjusted Funds From Operations (AFFO) (1)');
      return { page_number: page.page_number, text: table };
    }), definition_excerpts: inspection.definition_excerpts };
}

export async function buildAuditSource(row, inspection, pair, excerpt) {
  return { ticker: 'O', cik: '0000726728', issuer: 'Realty Income Corporation', source_type: 'ISSUER_IR_PDF',
    source_url: row.source_url, source_hash: inspection.download.source_hash, excerpt_hash: await excerptHash(excerpt),
    document_name: row.document_name, fiscal_year: row.year, fiscal_period: `Q${row.quarter}`, fiscal_year_end: '12-31',
    fiscal_year_end_source: '문서 기간 열 (Quarter/FY 12월 31일 연말)', published_at: inspection.filed_at,
    publication_date_basis: 'PDF에 명시된 해당 분기 earnings exhibit의 SEC 공개일; IR 게시일 별도 미확인',
    filed_at: inspection.filed_at, retrieved_at: inspection.download.retrieved_at, accession_number: row.accession, exhibit: row.exhibit,
    page_count: inspection.page_count, ffo_page: pair.ffo.page_number, affo_page: pair.affo.page_number };
}

export async function auditDocument(row, inspection, known = null) {
  const download = inspection?.download;
  const out = { year: row.year, quarter: row.quarter, id: `${row.year}-q${row.quarter}`, source_url: row.source_url,
    source_hash: download?.source_hash ?? null, http_status: download?.http_status ?? null, source_status: 'UNAVAILABLE',
    issuer: null, cik: null, issuer_evidence: null, period_verified: false, detected_format: null, adapter: null,
    parser_status: 'NOT_RUN', final_status: 'SOURCE_UNAVAILABLE', source_changed: false, published_at: row.published_at,
    filed_at: inspection?.filed_at ?? null, filed_evidence: inspection?.filed_evidence ?? null,
    normalized_ffo: 'UNKNOWN', unit_audit: null, structure: null, definitions: [], records: [], errors: [] };
  if (!download || download.source_url !== row.source_url || download.error || download.http_status !== 200) {
    out.errors.push({ code: 'SOURCE_UNAVAILABLE', message: download?.error || 'inventory와 접근 결과 불일치' }); return out;
  }
  out.source_status = 'AVAILABLE';
  if (!/^[a-f0-9]{64}$/.test(download.source_hash || '')) {
    out.final_status = 'NEEDS_REVIEW'; out.errors.push({ code: 'SOURCE_HASH_MISSING' }); return out;
  }
  if (known && download.source_hash !== known.document.source.source_hash) {
    out.source_changed = true; out.final_status = 'NEEDS_REVIEW'; out.errors.push({ code: 'SOURCE_CHANGED' }); return out;
  }
  if (inspection.error) { out.final_status = 'NEEDS_REVIEW'; out.errors.push({ code: 'EXTRACTION_ERROR', message: inspection.error }); return out; }
  const identity = inspection.identity_text;
  if (typeof identity !== 'string' || !identity) {
    out.final_status = 'NEEDS_REVIEW'; out.errors.push({ code: 'IDENTITY_MISSING' }); return out;
  }
  const legacyIdentity = /^Realty Income\b/.test(identity) && /New York Stock Exchange/.test(identity) && /the symbol ["“”]O["“”]/.test(identity);
  const modernIdentity = /^Realty Income(?: Corporation \(Realty Income, NYSE: O\)| \(NYSE: O\))$/.test(identity);
  if (!legacyIdentity && !modernIdentity) {
    out.final_status = 'WRONG_ISSUER'; out.issuer_evidence = identity; out.errors.push({ code: 'wrong_issuer' }); return out;
  }
  out.issuer = 'Realty Income Corporation'; out.cik = '0000726728'; out.issuer_evidence = identity;
  let pair;
  try { pair = tablePair(inspection); }
  catch (error) { out.final_status = 'UNKNOWN_FORMAT'; out.errors.push({ code: 'TABLE_SELECTION', message: error.message }); return out; }
  const footer = new RegExp(`Q${row.quarter} ${row.year} Supplemental Operating & Financial Data \\d+`);
  if (!Object.values(pair).every(page => footer.test(page.text))) {
    out.final_status = 'NEEDS_REVIEW'; out.errors.push({ code: 'PERIOD_IDENTITY_MISMATCH' }); return out;
  }
  out.period_verified = true;
  out.normalized_ffo = /^Normalized FFO available to common stockholders\s+\$?\s*[-(\d]/m.test(pair.ffo.text) ? 'YES' : 'NO';
  out.basis_disclosure = basisDisclosure(pair);
  out.unit_audit = unitAudit(pair);
  out.structure = { pages: Object.values(pair).map(page => page.page_number), headings: Object.values(pair).map(page => page.text.split('\n')[0]),
    share_rows: Object.values(pair).map(page => page.text.split('\n').filter(line => /(?:FFO|AFFO) per common share|^Basic\s|^Diluted\s/.test(line))),
    period_columns: Object.values(pair).map(page => page.text.split('\n').filter(line => /months ended|Years? ended|^\d{4} \d{4}/i.test(line))),
    normalized_ffo: out.normalized_ffo };
  // 원문 발췌의 의미는 바꾸지 않는다. 표 앞의 설명은 definition 근거로 따로 보존한다.
  const excerpt = buildAuditExcerpt(inspection, pair);
  let detection;
  try { detection = { status: 'detected', ...pdfFingerprint(excerpt) }; }
  catch (error) {
    out.final_status = error.code === 'BASIS_AMBIGUITY' ? 'NEEDS_REVIEW' : 'UNKNOWN_FORMAT';
    out.errors.push({ code: error.code || 'FORMAT_UNSUPPORTED', message: error.message }); return out;
  }
  out.detected_format = detection.format;
  if (detection.structural_strategy) out.structural_strategy = detection.structural_strategy;
  if (known) requireAudit(detection.format === known.result.format, '[REGRESSION BLOCKER] 기존 문서 format 변경');
  if (!out.unit_audit.supported) { out.final_status = 'NEEDS_REVIEW'; out.errors.push({ code: 'UNIT_UNKNOWN' }); return out; }
  out.adapter = 'parseRealtyIncomePdfText (read-only audit; production approval unchanged)';
  try {
    if (known) {
      // 같은 원문 hash의 이전 immutable 발췌/expected 결과만 유지한다. 신규 문서에는 이 경로가 없다.
      const candidate = await known.parse();
      requireAudit(JSON.stringify(candidate) === JSON.stringify(known.result), '[REGRESSION BLOCKER] 기존 문서 결과 변경');
      out.records = candidate.records; out.definitions = candidate.definitions; out.availability = candidate.availability;
    } else {
      // 날짜가 없으면 가짜 publication date를 채우지 않는다. 공시일은 PDF에 명시된 SEC 공개일 근거만 사용한다.
      if (!inspection.filed_at) { out.final_status = 'NEEDS_REVIEW'; out.errors.push({ code: 'PUBLICATION_DATE_UNCONFIRMED' }); return out; }
      const source = await buildAuditSource(row, inspection, pair, excerpt);
      const result = await parseRealtyIncomePdfText({ source, excerpt }, detection);
      if (result.status !== 'parsed') {
        out.parser_status = result.status; out.errors = result.errors;
        if (result.structure_status) out.structure_status = result.structure_status;
        if (result.definition_status) out.definition_status = result.definition_status;
        out.final_status = result.errors?.some(error => error.code === 'DOCUMENT_INVALID') ? 'PARSER_ERROR' : 'NEEDS_REVIEW'; return out;
      }
      requireAudit(result.records.every(record => record.validation_status === 'parsed'), '신규 문서의 자동 validated 승격 금지');
      out.records = result.records; out.definitions = result.definitions; out.availability = result.availability;
    }
    for (const record of out.records) assertMetricRecord(record);
    out.parser_status = 'parsed'; out.final_status = known ? 'VERIFIED_PARSED' : 'PARSED';
  } catch (error) { out.records = []; out.definitions = []; out.parser_status = 'error'; out.final_status = 'PARSER_ERROR'; out.errors.push({ code: 'PARSER_ERROR', message: error.message }); }
  return out;
}

export function deduplicate(rows) {
  const buckets = new Map(), provenance = new Set(); let observations = 0;
  for (const document of rows.filter(success)) for (const record of document.records) {
    observations++;
    const key = metricRecordKey(record), bucket = buckets.get(key) || [];
    const identical = bucket.find(item => item.canonical_value === record.canonical_value && item.canonical_unit === record.canonical_unit);
    if (identical) identical.records.push(record);
    else bucket.push({ canonical_value: record.canonical_value, canonical_unit: record.canonical_unit, records: [record] });
    buckets.set(key, bucket);
    for (const source of record.sources) provenance.add([key, source.source_url, source.source_hash, source.page_number, source.section].join('|'));
  }
  const conflicts = [...buckets].filter(([, variants]) => variants.length > 1).map(([key, variants]) => ({ key,
    metric: variants[0].records[0].metric_code, scope: variants[0].records[0].period_scope,
    period_start: variants[0].records[0].period_start, period_end: variants[0].records[0].period_end,
    variants: variants.map(variant => ({ value: variant.canonical_value, unit: variant.canonical_unit,
      sources: variant.records.map(record => ({ source_url: record.sources[0].source_url, year: record.sources[0].fiscal_year })) })),
    delta: variants.every(variant => variant.canonical_unit === variants[0].canonical_unit) ? variants[1].canonical_value - variants[0].canonical_value : null,
    possible_reason: '후속 비교값의 수정/반올림/표시 재분류 후보. 원문 대조가 필요하며 정답을 자동 선택하지 않음.', status: 'CONFLICT', overwrite: false }));
  return { observations, unique_keys: buckets.size, unique_values: [...buckets.values()].filter(values => values.length === 1).length,
    distinct_value_variants: [...buckets.values()].reduce((sum, values) => sum + values.length, 0), provenance: provenance.size,
    conflicts, validated_unique_keys: [...buckets.values()].filter(values => values.length === 1 && values[0].records.some(record => record.validation_status === 'validated')).length };
}

export function comparisons(rows) {
  const originals = new Map();
  for (const row of rows.filter(success)) for (const record of row.records.filter(record => record.fiscal_year === row.year)) originals.set(metricRecordKey(record), record);
  const pairs = [];
  for (const row of rows.filter(success)) for (const record of row.records.filter(record => record.fiscal_year !== row.year)) {
    const original = originals.get(metricRecordKey(record));
    if (original) pairs.push({ metric: record.metric_code, scope: record.period_scope, period_start: record.period_start, period_end: record.period_end,
      definition_version: record.definition_version, basis: record.value_basis, share_basis: record.share_basis,
      original_source: original.sources[0].source_url, later_source: record.sources[0].source_url,
      value_a: original.canonical_value, value_b: record.canonical_value, unit: record.canonical_unit,
      delta: record.canonical_unit === original.canonical_unit ? record.canonical_value - original.canonical_value : null,
      status: original.canonical_value === record.canonical_value && original.canonical_unit === record.canonical_unit ? 'EXACT_MATCH' : 'restated/comparative difference' });
  }
  return { comparable: pairs.length, exact_match: pairs.filter(row => row.status === 'EXACT_MATCH').length,
    difference: pairs.filter(row => row.status !== 'EXACT_MATCH').length, restated_candidates: pairs.filter(row => row.status !== 'EXACT_MATCH') };
}

export function metricCoverage(rows, scope) {
  const opportunities = rows.filter(row => scope === 'quarterly' || row.quarter === 4);
  const metrics = {};
  for (const metric of ['FFO', 'AFFO', 'NORMALIZED_FFO']) {
    const reported = opportunities.filter(row => row.normalized_ffo === 'YES' || metric !== 'NORMALIZED_FFO');
    metrics[metric] = { expected_opportunities: opportunities.length,
      confirmed_reported_opportunities: metric === 'NORMALIZED_FFO' ? reported.length : null,
      confirmed_not_reported: metric === 'NORMALIZED_FFO' ? opportunities.filter(row => row.normalized_ffo === 'NO').length : 0,
      unknown_disclosure: metric === 'NORMALIZED_FFO' ? opportunities.filter(row => row.normalized_ffo === 'UNKNOWN').length : 0 };
    metrics[metric].reported_basis_opportunities = {};
    for (const [basis, share] of [['total', 'not_applicable'], ['total', 'diluted'], ['per_share', 'basic'], ['per_share', 'diluted']]) {
      metrics[metric].reported_basis_opportunities[`${basis}/${share}`] = opportunities.filter(row => row.basis_disclosure?.[metric]?.[`${basis}/${share}`] === 'reported').length;
      metrics[metric][`${basis}/${share}`] = opportunities.filter(row => success(row) && row.records.some(record => record.fiscal_year === row.year
        && record.period_scope === scope && record.metric_code === metric && record.value_basis === basis && record.share_basis === share)).length;
    }
  }
  return { scope, primary_periods_only: true, opportunities: opportunities.length, metrics };
}

export function summarize(rows) {
  requireAudit(rows.length === 40 && new Set(rows.map(row => row.id)).size === 40, '40개 모두 방문해야 합니다.');
  // 알 수 없는 상태가 통계에서 조용히 누락되면 coverage를 확정할 수 없다.
  requireAudit(rows.every(row => FINAL_STATUSES.includes(row.final_status)), '모든 문서의 최종 상태를 결정해야 합니다.');
  const statuses = Object.fromEntries(FINAL_STATUSES.map(status => [status, rows.filter(row => row.final_status === status).length]));
  const formats = [...new Set([...Object.values(FORMATS), ...rows.map(row=>row.detected_format||'UNKNOWN'), 'UNKNOWN'])].map(format => {
    const group = rows.filter(row => (row.detected_format || 'UNKNOWN') === format);
    return { format, documents: group.length, parsed: group.filter(success).length,
      needs_review: group.filter(row => row.final_status === 'NEEDS_REVIEW').length,
      unknown: group.filter(row => row.final_status === 'UNKNOWN_FORMAT').length,
      failed: group.filter(row => ['SOURCE_UNAVAILABLE', 'WRONG_ISSUER', 'PARSER_ERROR'].includes(row.final_status)).length };
  }).filter(row => row.documents);
  return { visited: rows.length, source_available: rows.filter(row => row.source_status === 'AVAILABLE').length, statuses, formats,
    years: Array.from({ length: 10 }, (_, index) => { const year = 2016 + index, group = rows.filter(row => row.year === year);
      return { year, documents: group.length, parsed: group.filter(success).length, statuses: group.map(row => row.final_status) }; }),
    quarterly: metricCoverage(rows, 'quarterly'), annual: metricCoverage(rows, 'annual'), dedup: deduplicate(rows), comparison: comparisons(rows) };
}
