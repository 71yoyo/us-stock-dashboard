import { evidence, failedDocument, excerptHash } from './realty-income-document-formats.js';
import { parseRealtyIncomePdfText, extractRealtyIncomePdfStructure } from './realty-income-pdf-parser.js';
import { historicalDefinitions, historicalDefinition, normalizeHistoricalMetrics } from './realty-income-normalizer.js';

const compact = text => text.replace(/\s+/g, ' ').trim();

// 첫 번째/마지막 일치가 아니라 조정표 방향과 이웃 행 역할을 동시에 검증한다.
export function reconciliationCommonRow({ lines, metric, label, detection }) {
  if (detection.normalized) return null;
  const heading = metric === 'FFO' ? /^Funds From Operations \(FFO\)/ : /^Adjusted Funds From Operations \(AFFO\)/;
  evidence(heading.test(lines[0]), 'RECONCILIATION_CONTEXT', 'metric별 조정표 heading이 다릅니다.');
  if (metric === 'AFFO') {
    evidence(lines.some(line => /^Cumulative adjustments to calculate FFO\b/.test(line))
      && lines.some(line => /^FFO available to common stockholders\s+\d/.test(line)),
    'RECONCILIATION_CONTEXT', 'AFFO의 실제 FFO 시작점을 확인할 수 없습니다.');
  }
  const candidates = lines.map((line,index) => ({line,index})).filter(row => row.line.startsWith(label + ' ')
    && new RegExp(`^${metric} allocable to dilutive noncontrolling interests\\b`).test(lines[row.index + 1] || '')
    && new RegExp(`^Diluted ${metric}\\s+\\$`).test(lines[row.index + 2] || '')
    && (metric === 'FFO' ? /^FFO adjustments allocable to noncontrolling interests\b/.test(lines[row.index - 1] || '')
      : /^Other adjustments\b/.test(lines[row.index - 1] || '')));
  evidence(candidates.length === 1, 'RECONCILIATION_CONTEXT', '최종 common total 문맥이 중복/누락됐습니다.');
  return candidates[0];
}

function normalizedSentence(excerpt) {
  const paragraphs = (excerpt.definition_excerpts || []).filter(page => /^Normalized Funds from Operations Available/.test(compact(page.text)));
  const sentences = [...new Set(paragraphs.map(page => compact(page.text).match(/\bis FFO excluding ([^.]+)\./)?.[1]))];
  evidence(sentences.length === 1 && sentences[0], 'DEFINITION_REVIEW', 'Normalized FFO 공식 정의 문구가 없거나 충돌합니다.');
  return sentences[0];
}

// 새 정의는 기존 record와 분리한다. Spirit 추가는 비용 분류가 같아도 명시적 대상 범위 확대다.
export const SPIRIT_DEFINITIONS = {
  NORMALIZED_FFO: 'NFFO-MERGER-INTEGRATION-VEREIT-SPIRIT-V1',
  AFFO: 'AFFO-NFFO-VEREIT-SPIRIT-V1'
};
// 정의의 최초 승인 출처는 고정한다. 이후 문서별 실제 출처는 provenance에 별도로 남긴다.
const spiritDefinitionSource = 'https://www.realtyincome.com/sites/realty-income/files/realty-income/quartly-and-annual/realty-income-q4-2023-supplemental-information.pdf';
function spiritDefinition(metric) {
  return { metric_code:metric, definition_owner:'CIK0000726728', definition_version:SPIRIT_DEFINITIONS[metric],
    display_name:metric, profile:'REIT', metric_family:'real_estate_cash_earnings', default_unit:'USD',
    definition_source:spiritDefinitionSource,
    definition_notes:metric === 'NORMALIZED_FFO'
      ? 'VEREIT 및 Spirit 합병/통합 관련 비용을 제외하는 명시적 공시 범위. 기존 버전과 자동 동일 취급하지 않는다.'
      : 'VEREIT 및 Spirit 비용 제외 Normalized FFO에서 고유 수익/비용을 조정. 실제 항목은 문서별 provenance에 보존한다.' };
}

export function reviewDefinitionSemantics(document, detection) {
  const {excerpt} = document;
  // FFO 손상 범위와 일반 AFFO 정의는 기존 규칙으로 검증한다. NFFO는 별도로 좁게 판정한다.
  const base = historicalDefinitions(excerpt, {...detection,normalized:false});
  if (!detection.normalized) return {definitions:base,decision:'existing_ffo_affo',sentence:null};
  const sentence = normalizedSentence(excerpt), affo = compact(detection.affo.text);
  evidence(/Cumulative adjustments to calculate Normalized FFO/.test(affo)
    && /Normalized FFO available to common stockholders/.test(affo),
  'DEFINITION_REVIEW', 'AFFO가 Normalized FFO를 시작점으로 사용하는 근거가 없습니다.');
  const lines = detection.ffo.text.split('\n').map(compact).filter(Boolean);
  const ends = lines.map((line,index)=>({line,index})).filter(row => /^Normalized FFO available to common stockholders\s+\$/.test(row.line));
  evidence(ends.length === 1 && /^FFO available to common stockholders\s+\$/.test(lines[ends[0].index - 2] || ''),
    'DEFINITION_REVIEW', 'FFO → 제외 비용 → Normalized FFO 조정 방향이 모호하거나 추가 제외 행이 있습니다.');
  const adjustment = lines[ends[0].index - 1];
  let nffo, adjusted, decision;
  if (/^merger-related costs related to our (?:proposed )?merger with VEREIT$/.test(sentence)) {
    evidence(/^Merger-related costs\s+[-—(\d]/.test(adjustment),
      'DEFINITION_REVIEW', 'VEREIT 정의와 실제 제외 비용 행이 다릅니다.');
    nffo = historicalDefinition('NFFO-VEREIT-MERGER-V1'); adjusted = historicalDefinition('AFFO-NFFO-VEREIT-V1');
    decision = 'same_vereit_merger';
  } else if (sentence === 'merger and integration-related costs associated with our merger with VEREIT and Spirit') {
    evidence(/^Merger and integration-related costs\s+[-—(\d]/.test(adjustment), 'DEFINITION_REVIEW', 'Spirit 정의와 실제 조정 행이 다릅니다.');
    nffo = spiritDefinition('NORMALIZED_FFO'); adjusted = spiritDefinition('AFFO'); decision = 'new_explicit_spirit_scope';
  } else {
    evidence(false, 'DEFINITION_REVIEW', '검토하지 않은 제외 비용/대상 범위입니다. 기존 정의로 자동 승인하지 않습니다.');
  }
  return {definitions:[base.find(row=>row.metric_code==='FFO'),adjusted,nffo],decision,sentence};
}

// 읽기 전용 review entry point다. 기존 성공 결과는 한 필드도 바꾸지 않고 반환한다.
export async function parseReviewedRealtyIncomePdf(document, detection) {
  const legacy = await parseRealtyIncomePdfText(document,detection);
  if (legacy.status === 'parsed') return legacy;
  let formatStatus = 'supported', definitionStatus = 'review', valueStatus = 'blocked';
  try {
    const {observations,availability} = extractRealtyIncomePdfStructure(document,detection,
      detection.normalized ? {} : {resolveCommonRow:reconciliationCommonRow});
    const review = reviewDefinitionSemantics(document,detection);
    definitionStatus = 'approved';
    const result = normalizeHistoricalMetrics({observations,definitions:review.definitions,source:document.source,
      format:detection.format,inputHash:await excerptHash(document.excerpt),availability,
      structuralFeatures:detection.structural_strategy,
      definitionEvidence:{paragraphs:document.excerpt.definition_excerpts,ffo_table:detection.ffo.text,affo_table:detection.affo.text,
        decision:review.decision,normalized_sentence:review.sentence,
        note:'수동 의미 검토 adapter. 문서별 원문/페이지/hash/기간은 분리 보존. 자동 validated 승격 없음.'}});
    return {...result,format_status:formatStatus,definition_status:definitionStatus,value_status:'parsed'};
  } catch (error) {
    if (!['DEFINITION_UNKNOWN','DEFINITION_REVIEW'].includes(error.code)) {formatStatus='review';valueStatus='blocked';}
    return {...failedDocument(error),format_status:formatStatus,definition_status:definitionStatus,value_status:valueStatus};
  }
}
