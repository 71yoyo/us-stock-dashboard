import { REALTY_INCOME_DOCUMENTS } from './realty-income-mappings.js';
import { P5A_DOCUMENTS } from './realty-income-p5a-samples.js';

// P4는 확인한 네 PDF만 승인한다. 미조사 URL/기간을 연도만으로 같은 형식이라고 추측하지 않는다.
export const HISTORICAL_DOCUMENTS = [
  { id: 'fy2016', year: 2016, quarter: 4, published: '2017-02-22', pages: 27,
    url: 'https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2016/q4/Realty-Income-Q4-16-Supplemental-Information.pdf',
    hash: 'f989d35506f2f0bf1b6a17d24865ca5d87ae770aa7273458373ae313e3900d10', accession: null, exhibit: null },
  { id: 'q2-2019', year: 2019, quarter: 2, published: '2019-08-05', pages: 29,
    url: 'https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2019/q2/Realty-Income-Q2-2019-Supplemental-Information.pdf',
    hash: '9dd38670e6a33f5b00c50a3c05ae936010a8eac16fb53e667ea08d099517be99', accession: '0000726728-19-000075', exhibit: 'EX-99.2' },
  { id: 'q2-2021', year: 2021, quarter: 2, published: '2021-08-02', pages: 33,
    url: 'https://www.realtyincome.com/sites/realty-income/files/realty-income/quartly-and-annual/2021/Realty-Income-Q2-2021-Supplemental-Information-8.2.2021-new.pdf',
    hash: '06dc21dacc3f3df5e9d595333502f8619bfdea730931f249e6b00b6bb2a95cd1', accession: null, exhibit: 'EX-99.2' },
  { id: 'q2-2024', year: 2024, quarter: 2, published: '2024-08-05', pages: 32,
    url: 'https://www.realtyincome.com/sites/realty-income/files/2024-08/realty-income-q2-2024-supplemental-information.pdf',
    hash: 'ef66aa6179989a4b0f2ab22478601210f440274efa1756fd82ea7db19e0969db', accession: '0000726728-24-000114', exhibit: 'EX-99.2' }
];
export const FORMATS = {
  legacy: 'REALTY_INCOME_PDF_SEPARATE_NO_DILUTED_TOTAL',
  middle: 'REALTY_INCOME_PDF_SEPARATE_DILUTED_TOTAL',
  joint: 'REALTY_INCOME_PDF_NORMALIZED_JOINT_SHARES',
  mixed: 'REALTY_INCOME_PDF_NORMALIZED_MIXED_SHARES',
  modern: 'REALTY_INCOME_SEC_HTML_V1',
  legacyJoint: 'REALTY_INCOME_PDF_JOINT_NO_DILUTED_TOTAL',
  cashMixed: 'REALTY_INCOME_PDF_JOINT_FFO_SEPARATE_AFFO',
  normalizedAffoSeparate: 'REALTY_INCOME_PDF_NORMALIZED_JOINT_FFO_SEPARATE_AFFO'
};
export class DocumentFailure extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function evidence(condition, code, message) {
  if (!condition) throw new DocumentFailure(code, message);
}
export const textHash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
  .map(value => value.toString(16).padStart(2, '0')).join('');
export const excerptHash = excerpt => textHash(JSON.stringify(excerpt));
export function failedDocument(error) {
  return { status: ['wrong_issuer', 'SOURCE_HASH_MISMATCH'].includes(error.code) ? 'rejected' : 'needs_review',
    definitions: [], records: [], availability: [], errors: [{ code: error.code || 'DOCUMENT_INVALID', message: error.message }] };
}

function issuerEvidence(source, identity) {
  evidence(source && typeof source === 'object', 'SOURCE_UNSUPPORTED', '출처 정보가 없습니다.');
  evidence(source.ticker === 'O' && (!source.cik || source.cik === '0000726728')
    && (!source.issuer || source.issuer === 'Realty Income Corporation'), 'wrong_issuer', 'Realty Income 회사 식별정보가 아닙니다.');
  if (identity !== undefined) {
    evidence(typeof identity === 'string' && identity.length > 0, 'IDENTITY_MISSING', '기업 소개 발췌가 없습니다.');
    // 합병 설명의 VEREIT는 허용한다. 기업 소개의 주체와 NYSE 종목을 따로 확인한다.
    evidence(/^Realty Income\b/.test(identity) && /New York Stock Exchange/.test(identity)
      && /the symbol ["“]O["“]/.test(identity), 'wrong_issuer', '기업 소개의 발행회사/NYSE 티커가 일치하지 않습니다.');
  }
}

function pdfFingerprint(excerpt) {
  evidence(Array.isArray(excerpt.pages) && excerpt.pages.length === 2
    && new Set(excerpt.pages.map(page => page.page_number)).size === 2, 'TABLE_AMBIGUITY', '대표 FFO/AFFO 두 페이지가 필요합니다.');
  const ffo = excerpt.pages.find(page => /^(?:Funds From Operations \(FFO\)|FFO and Normalized FFO)/.test(page.text));
  const affo = excerpt.pages.find(page => /^(?:Adjusted Funds From Operations \(AFFO\)|AFFO \(1\))/.test(page.text));
  evidence(ffo && affo && ffo !== affo, 'TABLE_AMBIGUITY', '공식 FFO/AFFO 표 제목을 확인할 수 없습니다.');
  const has = (page, pattern) => pattern.test(page.text);
  const totals = has(ffo, /^FFO available to common stockholders\s+\$/m)
    && has(affo, /^(?:Total )?AFFO available to common stockholders\s+\$/m);
  // Q1은 두 연도 열 하나뿐이다. Q3는 quarterly/9M 두 그룹이며 구체적인 순서는 parser가 재검증한다.
  const columns = [ffo, affo].every(page => /Three months ended/i.test(page.text)
    && (/^\d{4} \d{4}$/m.test(page.text) || (/(?:Six months|Nine months|Year) ended/i.test(page.text)
      && /^\d{4} \d{4} \d{4} \d{4}$/m.test(page.text))));
  evidence(totals && columns && /SUPPLEMENTAL OPERATING/.test(excerpt.document_title || ''),
    'FORMAT_UNSUPPORTED', '복수 표 제목/총액/기간/문서 제목 fingerprint가 일치하지 않습니다.');
  const diluted = has(ffo, /^Diluted FFO\s+\$/m) && has(affo, /^Diluted AFFO\s+\$/m);
  const normalized = has(ffo, /^Normalized FFO available to common stockholders\s+\$/m);
  const separateFFO = has(ffo, /^FFO per common share:$/m);
  const separateAFFO = has(affo, /^AFFO per common share:?$/m);
  const jointFFO = has(ffo, /^FFO per common share, basic and diluted\s+\$/m);
  const jointAFFO = has(affo, /^AFFO per common share, basic and diluted\s+\$/m);
  const jointNorm = has(ffo, /^Normalized FFO per common share, basic and diluted\s+\$/m);
  if (!normalized && !diluted && jointFFO && jointAFFO && !separateFFO && !separateAFFO
    && !/^Diluted (?:FFO|AFFO)\s+\$/m.test(ffo.text + '\n' + affo.text)) {
    return { format: FORMATS.legacyJoint, ffo, affo, normalized, diluted };
  }
  if (diluted && jointFFO && separateAFFO && !separateFFO && !jointAFFO) {
    evidence(!normalized || jointNorm, 'BASIS_AMBIGUITY', 'Normalized FFO 주당값 근거가 없습니다.');
    return { format: normalized ? FORMATS.normalizedAffoSeparate : FORMATS.cashMixed, ffo, affo, normalized, diluted };
  }
  if (!normalized && separateFFO && separateAFFO && !jointFFO && !jointAFFO) {
    evidence(diluted || (!/^Diluted (?:FFO|AFFO)\s+\$/m.test(ffo.text + '\n' + affo.text)),
      'BASIS_AMBIGUITY', '한 표에만 diluted total이 있어 지원 형식이 아닙니다.');
    return { format: diluted ? FORMATS.middle : FORMATS.legacy, ffo, affo, normalized, diluted };
  }
  if (normalized && diluted && jointNorm && jointAFFO && !separateAFFO) {
    evidence(separateFFO !== jointFFO, 'BASIS_AMBIGUITY', 'FFO 주당값 표시 방식이 중복/누락됐습니다.');
    return { format: jointFFO ? FORMATS.joint : FORMATS.mixed, ffo, affo, normalized, diluted };
  }
  throw new DocumentFailure('FORMAT_UNSUPPORTED', '지원하지 않는 표/주당값 조합입니다. 검토가 필요합니다.');
}

export async function detectDocumentFormat(document) {
  try {
    evidence(document && typeof document === 'object', 'DOCUMENT_INVALID', '문서 입력이 필요합니다.');
    const { source, excerpt, html } = document;
    issuerEvidence(source, excerpt?.identity_text);
    if (typeof html === 'string') {
      const approved = REALTY_INCOME_DOCUMENTS[source.accession_number];
      evidence(!source.source_url?.includes('/data/') || source.source_url.includes('/data/726728/'), 'wrong_issuer', '다른 CIK의 SEC 문서입니다.');
      evidence(approved && /<table\b/i.test(html) && /Diluted FFO/.test(html) && /Diluted AFFO/.test(html),
        'FORMAT_UNSUPPORTED', '승인된 최근 SEC HTML 조정표가 아닙니다.');
      return { status: 'detected', format: FORMATS.modern };
    }
    evidence(excerpt && Array.isArray(excerpt.pages) && excerpt.pages.some(page => typeof page.text === 'string' && page.text.trim()),
      'IMAGE_ONLY_OR_UNSUPPORTED', '텍스트 없는 PDF는 OCR 자동 성공 처리하지 않습니다.');
    evidence(typeof excerpt.identity_text === 'string' && excerpt.identity_text.length > 0,
      'IDENTITY_MISSING', 'PDF 기업 소개 근거가 없습니다. ticker/metadata만으로 승인하지 않습니다.');
    issuerEvidence(source, excerpt.identity_text);
    const approved = [...HISTORICAL_DOCUMENTS, ...P5A_DOCUMENTS].find(row => row.url === source.source_url);
    evidence(approved && source.source_type === 'ISSUER_IR_PDF' && source.cik === '0000726728'
      && source.issuer === 'Realty Income Corporation' && source.document_name === approved.url.split('/').at(-1)
      && source.page_count === approved.pages && source.published_at === approved.published
      && source.filed_at === (approved.filed ?? approved.published) && source.fiscal_year === approved.year
      && source.fiscal_period === `Q${approved.quarter}` && source.fiscal_year_end === '12-31' && source.fiscal_year_end_source
      && source.accession_number === approved.accession && source.exhibit === approved.exhibit,
    'SOURCE_UNSUPPORTED', '승인된 대표 문서/출처/회계기간과 일치하지 않습니다.');
    evidence(source.source_hash === approved.hash && await excerptHash(excerpt) === source.excerpt_hash,
      'SOURCE_HASH_MISMATCH', 'PDF 원문 또는 최소 발췌 hash가 일치하지 않습니다.');
    const detected = pdfFingerprint(excerpt);
    for (const page of [detected.ffo, detected.affo]) {
      evidence(Number.isInteger(page.page_number) && page.page_number >= 1 && page.page_number <= approved.pages
        && new RegExp(`Q${approved.quarter} ${approved.year} Supplemental Operating & Financial Data ${page.page_number}$`).test(page.text),
      'PERIOD_AMBIGUITY', '표의 문서 footer/보고기간/페이지 근거가 일치하지 않습니다.');
    }
    evidence(detected.ffo.page_number === source.ffo_page && detected.affo.page_number === source.affo_page,
      'TABLE_AMBIGUITY', '출처의 표 위치와 실제 페이지가 다릅니다.');
    return { status: 'detected', ...detected, approved };
  } catch (error) { return failedDocument(error); }
}
