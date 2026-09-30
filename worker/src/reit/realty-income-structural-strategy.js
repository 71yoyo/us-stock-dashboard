// 레이아웃 조합을 metric별 feature로 표현한다. 연도/티커/expected 숫자를 사용하지 않는다.
export const STRUCTURAL_LEGACY_FORMAT = 'REALTY_INCOME_PDF_STRUCTURAL_LEGACY';
const requireStructure = (condition, code, message) => {
  if (!condition) { const error = new Error(message); error.code = code; throw error; }
};
// 빈 추출 행을 이용해 공동행 직후의 conflicting basis 검사를 우회할 수 없게 한다.
const linesOf = page => page.text.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);

export function shareLayout(page, name) {
  const lines = linesOf(page);
  const jointLabel = `${name} per common share, basic and diluted`;
  const direct = lines.map((line, index) => ({ line, index })).filter(row => row.line.startsWith(jointLabel + ' '));
  const headers = lines.map((line, index) => ({ line, index })).filter(row => [`${name} per common share:`, `${name} per common share`].includes(row.line));
  requireStructure(direct.length + headers.length === 1, 'BASIS_AMBIGUITY', `${name}: 주당행이 중복/누락됐습니다.`);
  const index = (direct[0] || headers[0]).index;
  if (direct.length) {
    requireStructure(!/^(?:Basic|Diluted)\b/i.test(lines[index + 1] || ''), 'BASIS_AMBIGUITY', 'joint 행에 별도 basis 행이 함께 있습니다.');
    return 'joint_basic_diluted';
  }
  if (/^Basic and Diluted\s+\$?\s*[-(\d]/i.test(lines[index + 1] || '')) {
    requireStructure(!/^(?:Basic|Diluted)\b/i.test(lines[index + 2] || ''), 'BASIS_AMBIGUITY', '공동행 뒤에 conflicting basis 행이 있습니다.');
    return 'joint_basic_diluted_subrow';
  }
  requireStructure(/^Basic\s+\$?\s*[-(\d]/.test(lines[index + 1] || '') && /^Diluted\s+\$?\s*[-(\d]/.test(lines[index + 2] || '')
    && !/^(?:Basic|Diluted)\b/i.test(lines[index + 3] || ''), 'BASIS_AMBIGUITY', '주당값과 가중주식수 행을 구별할 수 없습니다.');
  return 'separate';
}

export function structuralPdfFingerprint(excerpt) {
  requireStructure(excerpt.pages?.length === 2 && new Set(excerpt.pages.map(page => page.page_number)).size === 2,
    'TABLE_AMBIGUITY', '서로 다른 FFO/AFFO 조정표 두 개가 필요합니다.');
  const ffo = excerpt.pages.find(page => /^(?:Funds From Operations \(FFO\)|FFO and Normalized FFO)/.test(page.text));
  const affo = excerpt.pages.find(page => /^(?:Adjusted Funds From Operations \(AFFO\)|AFFO \(1\))/.test(page.text));
  requireStructure(ffo && affo && ffo !== affo && /SUPPLEMENTAL OPERATING/.test(excerpt.document_title || ''),
    'FORMAT_UNSUPPORTED', 'legacy supplemental 표 제목과 문서 identity가 필요합니다.');
  for (const page of [ffo, affo]) {
    requireStructure(/^\((?:dollars )?in thousands\s*, except per share (?:amounts|and share count data)\)$/.test(linesOf(page)[1]) && /\$/.test(page.text),
      'UNIT_UNKNOWN', '이번 strategy는 기존 USD thousand grammar만 지원합니다.');
    requireStructure(/Three months ended/i.test(page.text) && (/^\d{4} \d{4}$/m.test(page.text)
      || /(?:Six months|Nine months|Years?) ended/i.test(page.text) && /^\d{4} \d{4} \d{4} \d{4}$/m.test(page.text)),
    'PERIOD_AMBIGUITY', '기간 열의 의미를 확정할 수 없습니다.');
  }
  requireStructure(/^FFO available to common stockholders\s+\$/m.test(ffo.text)
    && /^(?:Total )?AFFO available to common stockholders\s+\$/m.test(affo.text), 'FORMAT_UNSUPPORTED', 'common total 공시행이 없습니다.');
  const normalized = /^Normalized FFO available to common stockholders\s+\$/m.test(ffo.text);
  const dilutedFFO = /^Diluted FFO\s+\$/m.test(ffo.text), dilutedAFFO = /^Diluted AFFO\s+\$/m.test(affo.text);
  requireStructure(dilutedFFO === dilutedAFFO && (!normalized || dilutedFFO && /^Diluted Normalized FFO\s+\$/m.test(ffo.text)),
    'BASIS_AMBIGUITY', 'metric별 diluted total 존재가 일치하지 않습니다.');
  const share_layouts = { FFO:shareLayout(ffo, 'FFO'), NORMALIZED_FFO:normalized ? shareLayout(ffo, 'Normalized FFO') : 'absent', AFFO:shareLayout(affo, 'AFFO') };
  const period_columns = /Years? ended/i.test(ffo.text) ? 'quarter_and_fy' : /Nine months ended/i.test(ffo.text)
    ? 'quarter_and_9m' : /Six months ended/i.test(ffo.text) ? 'quarter_and_6m' : 'single_quarter';
  return { format:STRUCTURAL_LEGACY_FORMAT, ffo, affo, normalized, diluted:dilutedFFO,
    structural_strategy:{ share_layouts, diluted_total:dilutedFFO ? 'present' : 'absent', period_columns } };
}
