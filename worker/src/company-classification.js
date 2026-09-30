// 회사 사업유형만 판정한다. ticker·상장 거래소·재무값·데이터 누락은 분류 근거가 아니다.
export const ANALYSIS_PROFILES = Object.freeze({
  GENERAL: 'GENERAL', REIT: 'REIT', BANK: 'BANK', EXCHANGE: 'EXCHANGE', UNKNOWN: 'UNKNOWN'
});
export const CLASSIFICATION_RULE_VERSION = 1;
const validProfiles = new Set(Object.values(ANALYSIS_PROFILES));
const normalize = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
const optionalText = value => typeof value === 'string' && value.trim() ? value.trim() : null;

export function isAnalysisProfile(value) {
  return typeof value === 'string' && validProfiles.has(value);
}

// 공급자의 정확한 산업명만 허용한다. 새 산업명은 검토 후 규칙 버전을 올려 추가한다.
const industryRules = new Map();
function registerIndustries(profile, sector, industries) {
  for (const industry of industries) industryRules.set(normalize(industry), { profile, sector: normalize(sector) });
}
registerIndustries(ANALYSIS_PROFILES.GENERAL, 'Technology', [
  'Semiconductors', 'Consumer Electronics', 'Software - Infrastructure'
]);
registerIndustries(ANALYSIS_PROFILES.GENERAL, 'Healthcare', [
  'Drug Manufacturers - General', 'Medical - Devices'
]);
registerIndustries(ANALYSIS_PROFILES.GENERAL, 'Consumer Cyclical', ['Specialty Retail', 'Auto - Manufacturers']);
registerIndustries(ANALYSIS_PROFILES.GENERAL, 'Communication Services', ['Internet Content & Information']);
registerIndustries(ANALYSIS_PROFILES.REIT, 'Real Estate', [
  'REIT - Retail', 'REIT - Industrial', 'REIT - Office', 'REIT - Residential',
  'REIT - Diversified', 'REIT - Healthcare Facilities', 'REIT - Hotel & Motel', 'REIT - Specialty'
]);
registerIndustries(ANALYSIS_PROFILES.BANK, 'Financial Services', ['Banks - Diversified', 'Banks - Regional']);
registerIndustries(ANALYSIS_PROFILES.EXCHANGE, 'Financial Services', ['Financial Data & Stock Exchanges']);

/** Sector는 보조적인 충돌 검사에만 사용한다. 없는 SIC/security type을 추정하지 않는다. */
export function classifyCompany(company = {}) {
  const industry = normalize(company?.industry);
  const sector = normalize(company?.sector);
  const rule = industryRules.get(industry);
  const result = (autoType, confidence, reason) => ({ autoType, confidence, reason,
    ruleVersion: CLASSIFICATION_RULE_VERSION,
    reviewStatus: autoType === ANALYSIS_PROFILES.UNKNOWN ? 'needs_review' : 'classified' });
  if (!industry) return result(ANALYSIS_PROFILES.UNKNOWN, 'low', 'Industry가 없어 사업유형을 확정할 수 없습니다.');
  if (!rule) return result(ANALYSIS_PROFILES.UNKNOWN, 'low', '검증된 Industry 분류 규칙이 없습니다.');
  if (sector && sector !== rule.sector) {
    return result(ANALYSIS_PROFILES.UNKNOWN, 'low', 'Sector와 Industry의 분류 근거가 충돌합니다.');
  }
  return result(rule.profile, 'high', '명시적으로 등록된 Industry 규칙과 일치합니다.');
}

/** API에서 Override의 유효성을 다시 확인한다. 오래된 저장값은 현재 metadata로 재판정한다. */
export function analysisProfileFor(company, stored = null) {
  const automatic = classifyCompany(company);
  const override = stored?.manual_override;
  const overridden = isAnalysisProfile(override) && Boolean(optionalText(stored?.manual_override_reason));
  const current = stored && stored.rule_version === CLASSIFICATION_RULE_VERSION
    && stored.source_sector === optionalText(company?.sector)
    && stored.source_industry === optionalText(company?.industry);
  return {
    type: overridden ? override : automatic.autoType,
    autoType: automatic.autoType,
    overridden,
    confidence: automatic.confidence,
    reason: overridden ? stored.manual_override_reason : automatic.reason,
    ruleVersion: CLASSIFICATION_RULE_VERSION,
    reviewStatus: overridden ? 'overridden' : automatic.reviewStatus,
    storageStatus: !stored ? 'not_stored' : current ? 'current' : 'stale'
  };
}

/** 자동 갱신은 Override 열을 쓰지 않는다. 유효 Profile과 검토 상태만 보존된 Override로 갱신한다. */
export function classificationStatement(DB, company) {
  const automatic = classifyCompany(company);
  return DB.prepare(`INSERT INTO company_classification
    (ticker, company_cik, auto_profile, effective_profile, source_sector, source_industry,
     classification_reason, confidence, rule_version, review_status, classified_at, updated_at)
    VALUES (?, (SELECT cik FROM companies WHERE ticker=?), ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker) DO UPDATE SET company_cik=excluded.company_cik,
      auto_profile=excluded.auto_profile,
      effective_profile=COALESCE(company_classification.manual_override, excluded.auto_profile),
      source_sector=excluded.source_sector, source_industry=excluded.source_industry,
      classification_reason=excluded.classification_reason, confidence=excluded.confidence,
      rule_version=excluded.rule_version,
      review_status=CASE WHEN company_classification.manual_override IS NOT NULL
        THEN 'overridden' ELSE excluded.review_status END,
      classified_at=excluded.classified_at, updated_at=excluded.updated_at`)
    .bind(company.ticker, company.ticker, automatic.autoType, automatic.autoType,
      optionalText(company.sector), optionalText(company.industry), automatic.reason,
      automatic.confidence, automatic.ruleVersion, automatic.reviewStatus);
}

// API GET은 저장·migration·외부 호출을 하지 않는다. 미적용 DB만 runtime 판정으로 돌아간다.
export async function readAnalysisProfile(environment, company) {
  let stored = null;
  try {
    stored = await environment.DB.prepare('SELECT * FROM company_classification WHERE ticker=?')
      .bind(company.ticker).first();
  } catch (error) {
    if (!/no such table:\s*(?:main\.)?company_classification\b/i.test(String(error?.message || error))) throw error;
  }
  return analysisProfileFor(company, stored);
}

/** 관리용 내부 함수이며 공개 HTTP route는 없다. null 지정만 Override 해제로 처리한다. */
export async function setManualClassification(environment, ticker, profile, reason = null) {
  if (typeof ticker !== 'string' || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    throw new Error('수동 분류 ticker 형식이 올바르지 않습니다.');
  }
  if (profile !== null && !isAnalysisProfile(profile)) throw new Error('지원하지 않는 Analysis Profile입니다.');
  const explanation = optionalText(reason);
  if (profile !== null && (!explanation || explanation.length > 1000)) {
    throw new Error('수동 분류 이유를 1~1000자로 입력해 주세요.');
  }
  const row = await environment.DB.prepare(`UPDATE company_classification
    SET manual_override=?, manual_override_reason=?, effective_profile=COALESCE(?, auto_profile),
      review_status=CASE WHEN ? IS NOT NULL THEN 'overridden'
        WHEN auto_profile='UNKNOWN' THEN 'needs_review' ELSE 'classified' END,
      updated_at=CURRENT_TIMESTAMP WHERE ticker=? RETURNING ticker`)
    .bind(profile, profile === null ? null : explanation, profile, profile, ticker).first();
  if (!row) throw new Error('회사 자동 분류를 먼저 저장한 뒤 수동 분류를 지정해 주세요.');
}
