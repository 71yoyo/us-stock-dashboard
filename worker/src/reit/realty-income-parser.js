import { REALTY_INCOME_DOCUMENTS, REALTY_INCOME_METRICS, REALTY_INCOME_TABLE_TITLES } from './realty-income-mappings.js';
import { assertMetricRecord } from '../specialized-metrics.js';

class ParseFailure extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function ensure(condition, code, message) { if (!condition) throw new ParseFailure(code, message); }
function plainText(html) {
  return html.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '').replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, number) => String.fromCodePoint(number[0].toLowerCase() === 'x'
      ? parseInt(number.slice(1), 16) : Number(number)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}
const label = text => text.toLowerCase().replace(/\s+/g, ' ').trim();
const sha256 = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map(value => value.toString(16).padStart(2, '0')).join('');

// colspan과 빈 셀을 유지한다. 열 위치가 밀려 YTD를 분기값으로 저장하는 일을 막는다.
function readRows(html) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => {
    let position = 0;
    const cells = [...match[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map(cell => {
      const span = Number(cell[1].match(/\bcolspan\s*=\s*["']?(\d+)/i)?.[1] || 1);
      const rowSpan = Number(cell[1].match(/\browspan\s*=\s*["']?(\d+)/i)?.[1] || 1);
      ensure(rowSpan === 1 && Number.isInteger(span) && span > 0 && span < 100, 'COLUMN_AMBIGUITY', '지원하지 않는 rowspan/colspan');
      const result = { start: position, end: position + span, text: plainText(cell[2]) };
      position += span;
      return result;
    });
    return { cells, width: position, text: cells.find(cell => cell.start === 0)?.text || '' };
  });
}

function periodColumns(rows, document) {
  const groups = rows.filter(row => row.cells.some(cell => /months ended|years ended/i.test(cell.text)));
  const years = rows.filter(row => row.cells.filter(cell => /^\d{4}$/.test(cell.text)).length === 4);
  ensure(groups.length === 1 && years.length === 1, 'COLUMN_AMBIGUITY', '기간/연도 머리글은 각각 하나여야 합니다.');
  const groupCells = groups[0].cells.filter(cell => cell.text);
  const yearCells = years[0].cells.filter(cell => /^\d{4}$/.test(cell.text));
  ensure(groupCells.length === 2 && groups[0].width === years[0].width, 'COLUMN_AMBIGUITY', '기간 열 그룹 수/폭 오류');
  const expectedMonths = [3, document.second_months];
  const columns = yearCells.map((cell, index) => {
    const owners = groupCells.filter(group => cell.start >= group.start && cell.end <= group.end);
    ensure(owners.length === 1, 'COLUMN_AMBIGUITY', '연도 열의 기간 그룹이 모호합니다.');
    const group = owners[0];
    const heading = group.text.replace(/ended(?=[A-Z])/g, 'ended ');
    const parsed = heading.match(/^(Three months|Six months|Years) ended (December|June) (\d{1,2}),?$/i);
    ensure(parsed, 'PERIOD_AMBIGUITY', '지원하지 않는 기간 머리글');
    const months = { 'three months': 3, 'six months': 6, years: 12 }[parsed[1].toLowerCase()];
    const month = parsed[2].toLowerCase() === 'december' ? 12 : 6;
    const groupIndex = groupCells.indexOf(group);
    const year = Number(cell.text);
    ensure(months === expectedMonths[groupIndex] && month === document.month && Number(parsed[3]) === document.day
      && year === document.year - index % 2 && groupIndex === Math.floor(index / 2), 'PERIOD_AMBIGUITY', '공식 adapter 기간과 표 머리글 불일치');
    // 공식 Q2/Q4 문서 label + 연말 12/31 근거 + 표의 실제 3/6/12개월 기간을 모두 확인한다.
    const scope = groupIndex === 0 ? 'quarterly' : document.second_scope;
    const startMonth = month - months + 1;
    return { start: cell.start, end: yearCells[index + 1]?.start ?? years[0].width,
      period_scope: scope, period_start: `${year}-${String(startMonth).padStart(2, '0')}-01`,
      period_end: `${year}-${String(month).padStart(2, '0')}-${document.day}`,
      fiscal_year: year, fiscal_period: scope === 'annual' ? 'FY' : document.fiscal_period,
      period_label: scope === 'annual' ? `FY${year}` : `${document.fiscal_period} FY${year}${scope === 'ytd' ? ' YTD' : ''}` };
  });
  return { columns, width: years[0].width };
}

function readNumber(row, column, width) {
  ensure(row.width === width, 'COLUMN_AMBIGUITY', '숫자 행과 머리글 열 폭이 다릅니다.');
  const overlapping = row.cells.filter(cell => cell.text && cell.start < column.end && cell.end > column.start);
  ensure(overlapping.every(cell => cell.start >= column.start && cell.end <= column.end), 'COLUMN_AMBIGUITY', '값 셀이 열 경계를 넘습니다.');
  const texts = overlapping.map(cell => cell.text).filter(text => text !== '$');
  ensure(texts.length === 1 && /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$|^\((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)$/.test(texts[0]),
    'VALUE_AMBIGUITY', '숫자 누락/중복/알 수 없는 형식');
  const number = Number(texts[0].replaceAll(',', '').replace(/^\((.*)\)$/, '-$1'));
  ensure(Number.isFinite(number), 'VALUE_AMBIGUITY', '유한한 숫자가 아닙니다.');
  return number;
}

function oneRow(rows, text) {
  const matches = rows.filter(row => label(row.text) === label(text));
  ensure(matches.length === 1, matches.length ? 'DUPLICATE_LABEL' : 'MISSING_LABEL', `${text}: 항목 개수 ${matches.length}`);
  return matches[0];
}

function metricRows(rows, metric, columns, width) {
  const diluted = oneRow(rows, metric.diluted);
  let common;
  if (metric.metric_code === 'FFO') {
    const repeated = rows.filter(row => label(row.text) === label(metric.common));
    ensure(repeated.length === 2 && rows.indexOf(repeated[0]) < rows.indexOf(diluted)
      && rows.indexOf(repeated[1]) === rows.indexOf(diluted) + 1,
    repeated.length < 2 ? 'MISSING_LABEL' : 'DUPLICATE_LABEL', 'FFO 조정표의 반복 시작 행 구조 오류');
    ensure(columns.every(column => readNumber(repeated[0], column, width) === readNumber(repeated[1], column, width)),
      'DUPLICATE_LABEL', '반복 FFO 행 값 불일치');
    common = repeated[0];
  } else common = oneRow(rows, metric.common);
  ensure(rows.indexOf(common) < rows.indexOf(diluted), 'BASIS_AMBIGUITY', '총액 행 순서 오류');
  const shareHeader = oneRow(rows, metric.shares);
  const shareIndex = rows.indexOf(shareHeader);
  const basic = rows[shareIndex + 1];
  const dilutedShare = rows[shareIndex + 2];
  ensure(label(basic?.text || '') === 'basic' && label(dilutedShare?.text || '') === 'diluted'
    && !['basic', 'diluted'].includes(label(rows[shareIndex + 3]?.text || '')),
  'BASIS_AMBIGUITY', '주당값 basic/diluted 행 누락/중복');
  return [
    { row: common, value_basis: 'total', share_basis: 'not_applicable', attribution_basis: 'common_stockholders' },
    { row: diluted, value_basis: 'total', share_basis: 'diluted', attribution_basis: 'common_and_dilutive_noncontrolling_interests' },
    { row: basic, value_basis: 'per_share', share_basis: 'basic', attribution_basis: 'common_stockholders' },
    { row: dilutedShare, value_basis: 'per_share', share_basis: 'diluted', attribution_basis: 'common_and_dilutive_noncontrolling_interests' }
  ];
}

export async function parseRealtyIncomeHtml({ html, source }) {
  try {
    ensure(typeof html === 'string' && html.length > 0 && html.length < 3000000, 'DOCUMENT_INVALID', 'HTML 크기/형식 오류');
    const document = REALTY_INCOME_DOCUMENTS[source?.accession_number];
    ensure(document && source.ticker === 'O' && source.source_type === 'SEC_EXHIBIT'
      && source.document_name === document.document_name && source.published_at === document.published_at
      && source.filed_at === document.published_at && source.exhibit === 'EX-99.1'
      && source.fiscal_period === document.fiscal_period && source.fiscal_year_end === '12-31'
      && source.fiscal_year_end_source, 'SOURCE_UNSUPPORTED', '지원하지 않는 문서/공식 회계기간 근거');
    const expectedUrl = `https://www.sec.gov/Archives/edgar/data/726728/${source.accession_number.replaceAll('-', '')}/${document.document_name}`;
    ensure(source.source_url === expectedUrl, 'SOURCE_UNSUPPORTED', '공식 SEC 문서 URL 불일치');
    const inputHash = await sha256(html);
    ensure(inputHash === source.source_hash || inputHash === source.excerpt_hash, 'SOURCE_HASH_MISMATCH', '입력 HTML과 원문/발췌 hash 불일치');
    const version = `EX99.1-${document.year}-${document.fiscal_period}`;
    const definitions = REALTY_INCOME_METRICS.map(metric => ({ metric_code: metric.metric_code,
      definition_owner: 'CIK0000726728', definition_version: version, display_name: metric.display_name,
      profile: 'REIT', metric_family: 'real_estate_cash_earnings', default_unit: 'USD',
      definition_source: source.source_url, definition_notes: `${metric.notes} ${source.published_at} EX-99.1 조정표·Glossary 기준.` }));
    const sections = new Map();
    let previousEnd = 0;
    for (const match of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
      const rows = readRows(match[0]).filter(row => row.cells.some(cell => cell.text));
      const kind = rows.some(row => label(row.text) === 'diluted ffo') ? 'ffo'
        : rows.some(row => label(row.text) === 'diluted affo') ? 'affo' : null;
      const prefix = plainText(html.slice(previousEnd, match.index));
      previousEnd = match.index + match[0].length;
      if (!kind) continue;
      ensure(!sections.has(kind), 'DUPLICATE_LABEL', '동일 지표 조정표 중복');
      ensure(/in thousands, except per share amounts/i.test(prefix), 'UNIT_UNKNOWN', '표의 원 단위 근거 없음');
      ensure(label(prefix).includes(label(REALTY_INCOME_TABLE_TITLES[kind])), 'MISSING_LABEL', '공식 표 제목 누락');
      sections.set(kind, { rows, ...periodColumns(rows, document) });
    }
    ensure(sections.size === 2, 'MISSING_LABEL', 'FFO/AFFO 조정표 누락');
    const records = [];
    for (const metric of REALTY_INCOME_METRICS) {
      const section = sections.get(metric.section);
      for (const basis of metricRows(section.rows, metric, section.columns, section.width)) {
        for (const column of section.columns) {
          const { row, ...basisFields } = basis;
          const { start, end, ...period } = column;
          const rawValue = readNumber(row, column, section.width);
          const perShare = basis.value_basis === 'per_share';
          const record = { ticker: 'O', metric_code: metric.metric_code, definition_owner: 'CIK0000726728',
            definition_version: version, ...period, ...basisFields, raw_value: rawValue,
            raw_unit: perShare ? 'USD/share' : 'USD thousand', raw_unit_multiplier: perShare ? 1 : 1000,
            canonical_value: rawValue * (perShare ? 1 : 1000), canonical_unit: perShare ? 'USD/share' : 'USD',
            validation_status: 'parsed', validation: null,
            sources: [{ ...source, input_hash: inputHash, table_title: REALTY_INCOME_TABLE_TITLES[metric.section],
              section: `${metric.section} reconciliation / ${row.text}`, page_number: null }] };
          records.push(assertMetricRecord(record));
        }
      }
    }
    ensure(records.length === 48, 'COLUMN_AMBIGUITY', '지원 형식의 전체 record 수 불일치');
    return { status: 'parsed', definitions, records, errors: [] };
  } catch (error) {
    // 일부 행만 성공해도 저장하지 않는다. 빈/null/추정값으로 정상 결과를 가장하지 않는다.
    return { status: 'needs_review', definitions: [], records: [],
      errors: [{ code: error.code || 'DOCUMENT_INVALID', message: error.message }] };
  }
}
