import { evidence, failedDocument, excerptHash } from './realty-income-document-formats.js';
import { historicalDefinitions, normalizeHistoricalMetrics } from './realty-income-normalizer.js';

const linesOf = page => page.text.split('\n').map(line => line.replace(/\s+/g, ' ').trim());
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function rowNumbers(line, rowLabel) {
  const suffix = line.slice(rowLabel.length).trim().replace(/\$\s*/g, '');
  const tokens = suffix.split(/\s+/);
  evidence(tokens.length === 4 && tokens.every(token => /^(?:-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\))$/.test(token)),
    'VALUE_AMBIGUITY', `${rowLabel}: 네 숫자 열을 확정할 수 없습니다.`);
  return tokens.map(token => Number(token.replaceAll(',', '').replace(/^\((.*)\)$/, '-$1')));
}
function rowsFor(lines, name) {
  return lines.map((line, index) => ({ line, index })).filter(row => new RegExp(`^${escape(name)}\\s+(?=[$\\d(\\-])`).test(row.line));
}
function uniqueRow(lines, name) {
  const matches = rowsFor(lines, name);
  evidence(matches.length === 1, matches.length ? 'DUPLICATE_LABEL' : 'MISSING_LABEL', `${name}: 행 개수 ${matches.length}`);
  return { ...matches[0], values: rowNumbers(matches[0].line, name), label: name };
}
function periods(page, source) {
  const lines = linesOf(page), years = lines.map((line, index) => ({ line, index })).filter(row => /^\d{4} \d{4} \d{4} \d{4}$/.test(row.line));
  evidence(years.length === 1, 'PERIOD_AMBIGUITY', '연도 머리글이 중복/누락됐습니다.');
  const yearRow = years[0], prefix = lines.slice(0, yearRow.index).join(' ');
  const singleLine = /Three months ended/i.test(lines[yearRow.index - 1] || '');
  const header = lines.slice(yearRow.index - (singleLine ? 1 : 2), yearRow.index).join(' ');
  const dates = prefix.match(/(?:June 30|December 31),/g) || [];
  const yearEnd = source.fiscal_period === 'Q4';
  const date = yearEnd ? 'December 31,' : 'June 30,';
  const second = yearEnd ? 'Year' : 'Six months';
  const groupFirst = new RegExp(`^Three months ended ${second} ended ${date} ${date}$`, 'i');
  const dateInGroup = new RegExp(`^Three months ended ${date} ${second} ended ${date}$`, 'i');
  evidence(groupFirst.test(header) || dateInGroup.test(header), 'PERIOD_AMBIGUITY', '기간 그룹의 실제 좌우 순서가 다릅니다.');
  evidence(/Three months ended/i.test(prefix) && (yearEnd ? /Year ended/i : /Six months ended/i).test(prefix)
    && dates.length === 2 && dates.every(date => date === (yearEnd ? 'December 31,' : 'June 30,')),
  'PERIOD_AMBIGUITY', '실제 기간 그룹/날짜 머리글이 승인된 기간과 다릅니다.');
  return yearRow.line.split(' ').map((text, index) => {
    const year = Number(text), quarterly = index < 2;
    evidence(year === source.fiscal_year - index % 2, 'PERIOD_AMBIGUITY', '열의 현재/비교 연도 순서가 다릅니다.');
    const scope = quarterly ? 'quarterly' : yearEnd ? 'annual' : 'ytd';
    const startMonth = quarterly ? yearEnd ? '10' : '04' : '01';
    return { period_scope: scope, period_start: `${year}-${startMonth}-01`, period_end: `${year}-${yearEnd ? '12-31' : '06-30'}`,
      fiscal_year: year, fiscal_period: scope === 'annual' ? 'FY' : source.fiscal_period,
      period_label: scope === 'annual' ? `FY${year}` : `${source.fiscal_period} FY${year}${scope === 'ytd' ? ' YTD' : ''}` };
  });
}
function tableUnit(page) {
  // 최근 문서의 multiplier를 복사하지 않고 각 표 제목 바로 아래 단위 + 달러 기호를 검증한다.
  const lines = linesOf(page);
  evidence(/^\((?:dollars )?in thousands, except per share amounts\)$/.test(lines[1])
    && /\$/.test(page.text), 'UNIT_UNKNOWN', '표의 달러/천 단위 명시를 확인할 수 없습니다.');
  return 'USD thousand';
}
function shareRows(lines, name) {
  const jointName = `${name} per common share, basic and diluted`;
  const joint = rowsFor(lines, jointName), header = lines.filter(line => line === `${name} per common share:`);
  evidence(joint.length + header.length === 1, 'BASIS_AMBIGUITY', '주당값 표시가 모호합니다.');
  if (joint.length) {
    const row = uniqueRow(lines, jointName);
    return ['basic', 'diluted'].map(basis => ({ ...row, basis, disclosure: 'basic_and_diluted_joint' }));
  }
  const index = lines.indexOf(`${name} per common share:`);
  evidence(/^Basic\s/.test(lines[index + 1] || '') && /^Diluted\s/.test(lines[index + 2] || '')
    && !/^(Basic|Diluted)\s/.test(lines[index + 3] || ''), 'BASIS_AMBIGUITY', '주당값 행과 주식수 행을 구별할 수 없습니다.');
  return ['basic', 'diluted'].map((basis, offset) => ({ values: rowNumbers(lines[index + 1 + offset], offset ? 'Diluted' : 'Basic'),
    label: `${name} per common share / ${basis}`, basis, disclosure: 'separate' }));
}

function extractMetric(page, metric, detection, source) {
  const name = metric === 'NORMALIZED_FFO' ? 'Normalized FFO' : metric;
  const lines = linesOf(page), columns = periods(page, source), unit = tableUnit(page);
  const commonLabel = metric === 'AFFO' && rowsFor(lines, 'Total AFFO available to common stockholders').length
    ? 'Total AFFO available to common stockholders' : `${name} available to common stockholders`;
  const commonRows = rowsFor(lines, commonLabel);
  const expectedRepeats = metric === 'FFO' && detection.normalized ? 2 : 1;
  evidence(commonRows.length === expectedRepeats, 'DUPLICATE_LABEL', '총액 행의 중복/누락 구조가 다릅니다.');
  const common = { values: rowNumbers(commonRows[0].line, commonLabel), label: commonLabel };
  const bases = [{ ...common, value_basis: 'total', share_basis: 'not_applicable', attribution_basis: 'common_stockholders', disclosure: 'total' }];
  if (detection.diluted) {
    const diluted = uniqueRow(lines, `Diluted ${name}`);
    evidence(commonRows[0].index < diluted.index, 'BASIS_AMBIGUITY', '총액과 diluted total 행 순서가 다릅니다.');
    if (expectedRepeats === 2) {
      const repeated = rowNumbers(commonRows[1].line, commonLabel);
      evidence(commonRows[1].index === diluted.index + 1 && repeated.every((v, index) => v === common.values[index]),
        'DUPLICATE_LABEL', 'Normalized FFO 조정표 시작점의 반복 FFO가 다릅니다.');
    }
    bases.push({ ...diluted, value_basis: 'total', share_basis: 'diluted',
      attribution_basis: 'common_and_dilutive_noncontrolling_interests', disclosure: 'diluted_total' });
  }
  for (const row of shareRows(lines, name)) bases.push({ ...row, value_basis: 'per_share', share_basis: row.basis,
    attribution_basis: row.basis === 'diluted' && detection.diluted ? 'common_and_dilutive_noncontrolling_interests' : 'common_stockholders' });
  return bases.flatMap(basis => columns.map((period, index) => ({ metric_code: metric, ...period,
    value_basis: basis.value_basis, share_basis: basis.share_basis, attribution_basis: basis.attribution_basis,
    raw_value: basis.values[index], unit: basis.value_basis === 'per_share' ? 'USD/share' : unit,
    page, row_label: basis.label, share_disclosure: basis.disclosure })));
}

export async function parseRealtyIncomePdfText(document, detection) {
  try {
    const { source, excerpt } = document;
    const definitions = historicalDefinitions(excerpt, detection);
    const metrics = detection.normalized ? ['FFO', 'NORMALIZED_FFO', 'AFFO'] : ['FFO', 'AFFO'];
    const observations = metrics.flatMap(metric => extractMetric(metric === 'AFFO' ? detection.affo : detection.ffo, metric, detection, source));
    const availability = [];
    if (!detection.normalized) availability.push({ metric_code: 'NORMALIZED_FFO', status: 'not_reported', value: null,
      reason: '대표 조정표에서 Normalized FFO를 공시하지 않음. 임의 계산 금지.' });
    if (!detection.diluted) for (const metric of metrics) availability.push({ metric_code: metric,
      value_basis: 'total', share_basis: 'diluted', status: 'not_reported', value: null, reason: 'diluted total 공시행 없음. 주당값×주식수 역산 금지.' });
    return normalizeHistoricalMetrics({ observations, definitions, source, format: detection.format, inputHash: await excerptHash(excerpt),
      availability, definitionEvidence: { paragraphs: excerpt.definition_excerpts,
        ffo_table: detection.ffo.text, affo_table: detection.affo.text, note: '레이아웃과 정의는 별개. 실제 조정항목을 보존하며 자동 비교/재계산하지 않음.' } });
  } catch (error) { return failedDocument(error); }
}
