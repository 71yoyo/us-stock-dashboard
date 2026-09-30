import { evidence, failedDocument, excerptHash } from './realty-income-document-formats.js';
import { historicalDefinitions, normalizeHistoricalMetrics } from './realty-income-normalizer.js';

const linesOf = page => page.text.split('\n').map(line => line.replace(/\s+/g, ' ').trim());
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function rowNumbers(line, rowLabel, columnCount = 4) {
  const suffix = line.slice(rowLabel.length).trim().replace(/\$\s*/g, '');
  const tokens = suffix.split(/\s+/);
  evidence(tokens.length === columnCount && tokens.every(token => /^(?:-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\))$/.test(token)),
    'VALUE_AMBIGUITY', `${rowLabel}: ${columnCount}개 숫자 열을 확정할 수 없습니다.`);
  return tokens.map(token => Number(token.replaceAll(',', '').replace(/^\((.*)\)$/, '-$1')));
}
function rowsFor(lines, name) {
  return lines.map((line, index) => ({ line, index })).filter(row => new RegExp(`^${escape(name)}\\s+(?=[$\\d(\\-])`).test(row.line));
}
function uniqueRow(lines, name, columnCount) {
  const matches = rowsFor(lines, name);
  evidence(matches.length === 1, matches.length ? 'DUPLICATE_LABEL' : 'MISSING_LABEL', `${name}: 행 개수 ${matches.length}`);
  return { ...matches[0], values: rowNumbers(matches[0].line, name, columnCount), label: name };
}
function periods(page, source) {
  const lines = linesOf(page), years = lines.map((line, index) => ({ line, index })).filter(row => /^\d{4} \d{4}(?: \d{4} \d{4})?$/.test(row.line));
  evidence(years.length === 1, 'PERIOD_AMBIGUITY', '연도 머리글이 중복/누락됐습니다.');
  const yearRow = years[0], prefix = lines.slice(0, yearRow.index).join(' ');
  const quarter = Number(source.fiscal_period.slice(1));
  const endDates = ['03-31', '06-30', '09-30', '12-31'];
  const dateNames = ['March 31,', 'June 30,', 'September 30,', 'December 31,'];
  evidence(quarter >= 1 && quarter <= 4, 'PERIOD_AMBIGUITY', '분기 식별자가 없습니다.');
  const width = yearRow.line.split(' ').length;
  evidence(width === (quarter === 1 ? 2 : 4), 'PERIOD_AMBIGUITY', 'Q1 단일 기간 또는 분기/누적 열 수가 다릅니다.');
  const singleLine = /Three months ended/i.test(lines[yearRow.index - 1] || '');
  const header = lines.slice(yearRow.index - (singleLine ? 1 : 2), yearRow.index).join(' ');
  const dates = prefix.match(/(?:March 31|June 30|September 30|December 31),/g) || [];
  const yearEnd = source.fiscal_period === 'Q4';
  const date = dateNames[quarter - 1];
  const second = yearEnd ? 'Years?' : quarter === 3 ? 'Nine months' : 'Six months';
  const groupFirst = new RegExp(`^Three months ended ${second} ended ${date} ${date}$`, 'i');
  const dateInGroup = new RegExp(`^Three months ended ${date} ${second} ended ${date}$`, 'i');
  evidence(quarter === 1 ? /^Three months ended March 31,$/i.test(header) : groupFirst.test(header) || dateInGroup.test(header),
    'PERIOD_AMBIGUITY', '기간 그룹의 실제 좌우 순서가 다릅니다.');
  evidence(/Three months ended/i.test(prefix) && (quarter === 1 || new RegExp(`${second} ended`, 'i').test(prefix))
    && dates.length === (quarter === 1 ? 1 : 2) && dates.every(value => value === date),
  'PERIOD_AMBIGUITY', '실제 기간 그룹/날짜 머리글이 승인된 기간과 다릅니다.');
  return yearRow.line.split(' ').map((text, index) => {
    const year = Number(text), quarterly = index < 2;
    evidence(year === source.fiscal_year - index % 2, 'PERIOD_AMBIGUITY', '열의 현재/비교 연도 순서가 다릅니다.');
    const scope = quarterly ? 'quarterly' : yearEnd ? 'annual' : 'ytd';
    // Q1 자료의 3개월은 YTD와 경제기간이 같지만 실제로 한 그룹만 공시하므로 quarterly 하나만 저장한다.
    const startMonth = quarterly ? String((quarter - 1) * 3 + 1).padStart(2, '0') : '01';
    return { period_scope: scope, period_start: `${year}-${startMonth}-01`, period_end: `${year}-${endDates[quarter - 1]}`,
      fiscal_year: year, fiscal_period: scope === 'annual' ? 'FY' : source.fiscal_period,
      period_label: scope === 'annual' ? `FY${year}` : `${source.fiscal_period} FY${year}${scope === 'ytd' ? ' YTD' : ''}` };
  });
}
function tableUnit(page) {
  // 최근 문서의 multiplier를 복사하지 않고 각 표 제목 바로 아래 단위 + 달러 기호를 검증한다.
  const lines = linesOf(page);
  evidence(/^\((?:dollars )?in thousands\s*, except per share (?:amounts|and share count data)\)$/.test(lines[1])
    && /\$/.test(page.text), 'UNIT_UNKNOWN', '표의 달러/천 단위 명시를 확인할 수 없습니다.');
  return 'USD thousand';
}
function shareRows(lines, name, columnCount) {
  const jointName = `${name} per common share, basic and diluted`;
  const joint = rowsFor(lines, jointName), header = lines.filter(line => line === `${name} per common share:` || line === `${name} per common share`);
  evidence(joint.length + header.length === 1, 'BASIS_AMBIGUITY', '주당값 표시가 모호합니다.');
  if (joint.length) {
    const row = uniqueRow(lines, jointName, columnCount);
    return ['basic', 'diluted'].map(basis => ({ ...row, basis, disclosure: 'basic_and_diluted_joint' }));
  }
  const index = lines.indexOf(header[0]);
  // 명시적 공동행은 산술 계산 없이 같은 공시값을 두 basis로 기록한다. 별도 conflicting 행은 차단한다.
  if (/^Basic and Diluted\s+\$/i.test(lines[index + 1] || '')) {
    evidence(!/^(?:Basic|Diluted)\b/i.test(lines[index + 2] || ''), 'BASIS_AMBIGUITY', '공동행과 별도 basis 행이 충돌합니다.');
    const sourceLabel = lines[index + 1].match(/^Basic and Diluted/i)[0];
    const values = rowNumbers(lines[index + 1], sourceLabel, columnCount);
    return ['basic', 'diluted'].map(basis => ({ values, label:`${name} per common share / ${sourceLabel}`, basis, disclosure:'joint_basic_diluted' }));
  }
  evidence(/^Basic\s/.test(lines[index + 1] || '') && /^Diluted\s/.test(lines[index + 2] || '')
    && !/^(Basic|Diluted)\s/.test(lines[index + 3] || ''), 'BASIS_AMBIGUITY', '주당값 행과 주식수 행을 구별할 수 없습니다.');
  return ['basic', 'diluted'].map((basis, offset) => ({ values: rowNumbers(lines[index + 1 + offset], offset ? 'Diluted' : 'Basic', columnCount),
    label: `${name} per common share / ${basis}`, basis, disclosure: 'separate' }));
}

function extractMetric(page, metric, detection, source, options = {}) {
  const name = metric === 'NORMALIZED_FFO' ? 'Normalized FFO' : metric;
  const lines = linesOf(page), columns = periods(page, source), unit = tableUnit(page);
  const commonLabel = metric === 'AFFO' && rowsFor(lines, 'Total AFFO available to common stockholders').length
    ? 'Total AFFO available to common stockholders' : `${name} available to common stockholders`;
  const commonRows = rowsFor(lines, commonLabel);
  const expectedRepeats = metric === 'FFO' && detection.normalized ? 2 : 1;
  // 검토 adapter만 문맥 resolver를 전달한다. 기존 추출 경로의 반복행 계약은 바꾸지 않는다.
  const resolved = options.resolveCommonRow?.({ lines, metric, label:commonLabel, detection });
  if (!resolved) evidence(commonRows.length === expectedRepeats, 'DUPLICATE_LABEL', '총액 행의 중복/누락 구조가 다릅니다.');
  const commonRow = resolved || commonRows[0];
  const common = { values: rowNumbers(commonRow.line, commonLabel, columns.length), label: commonLabel };
  const bases = [{ ...common, value_basis: 'total', share_basis: 'not_applicable', attribution_basis: 'common_stockholders', disclosure: 'total' }];
  if (detection.diluted) {
    const diluted = uniqueRow(lines, `Diluted ${name}`, columns.length);
    evidence(commonRow.index < diluted.index, 'BASIS_AMBIGUITY', '총액과 diluted total 행 순서가 다릅니다.');
    if (expectedRepeats === 2) {
      const repeated = rowNumbers(commonRows[1].line, commonLabel, columns.length);
      evidence(commonRows[1].index === diluted.index + 1 && repeated.every((v, index) => v === common.values[index]),
        'DUPLICATE_LABEL', 'Normalized FFO 조정표 시작점의 반복 FFO가 다릅니다.');
    }
    bases.push({ ...diluted, value_basis: 'total', share_basis: 'diluted',
      attribution_basis: 'common_and_dilutive_noncontrolling_interests', disclosure: 'diluted_total' });
  }
  for (const row of shareRows(lines, name, columns.length)) bases.push({ ...row, value_basis: 'per_share', share_basis: row.basis,
    attribution_basis: row.basis === 'diluted' && detection.diluted ? 'common_and_dilutive_noncontrolling_interests' : 'common_stockholders' });
  return bases.flatMap(basis => columns.map((period, index) => ({ metric_code: metric, ...period,
    value_basis: basis.value_basis, share_basis: basis.share_basis, attribution_basis: basis.attribution_basis,
    raw_value: basis.values[index], unit: basis.value_basis === 'per_share' ? 'USD/share' : unit,
    page, row_label: basis.label, share_disclosure: basis.disclosure })));
}

export function extractRealtyIncomePdfStructure(document, detection, options = {}) {
  const { source } = document;
  const metrics = detection.normalized ? ['FFO', 'NORMALIZED_FFO', 'AFFO'] : ['FFO', 'AFFO'];
  const observations = metrics.flatMap(metric => extractMetric(metric === 'AFFO' ? detection.affo : detection.ffo, metric, detection, source, options));
  const availability = [];
  if (!detection.normalized) availability.push({ metric_code:'NORMALIZED_FFO', status:'not_reported', value:null,
    reason:'대표 조정표에서 Normalized FFO를 공시하지 않음. 임의 계산 금지.' });
  if (!detection.diluted) for (const metric of metrics) availability.push({ metric_code:metric,
    value_basis:'total', share_basis:'diluted', status:'not_reported', value:null, reason:'diluted total 공시행 없음. 주당값×주식수 역산 금지.' });
  return { observations, availability };
}

export async function parseRealtyIncomePdfText(document, detection) {
  let structure;
  try {
    const { source, excerpt } = document;
    if (detection.structural_strategy) structure = extractRealtyIncomePdfStructure(document, detection);
    const definitions = historicalDefinitions(excerpt, detection);
    const { observations, availability } = structure || extractRealtyIncomePdfStructure(document, detection);
    return normalizeHistoricalMetrics({ observations, definitions, source, format: detection.format, inputHash: await excerptHash(excerpt),
      structuralFeatures:detection.structural_strategy,
      availability, definitionEvidence: { paragraphs: excerpt.definition_excerpts,
        ffo_table: detection.ffo.text, affo_table: detection.affo.text, note: '레이아웃과 정의는 별개. 실제 조정항목을 보존하며 자동 비교/재계산하지 않음.' } });
  } catch (error) {
    const failure = failedDocument(error);
    // 구조 성공과 정의 승인 실패를 분리하되 검토 중인 numeric record는 만들지 않는다.
    return structure && ['DEFINITION_UNKNOWN', 'DEFINITION_REVIEW'].includes(error.code)
      ? { ...failure, structure_status:'parsed', definition_status:'needs_review' } : failure;
  }
}
