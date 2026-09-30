// 최근 두 EX-99.1만 승인한 소스 adapter다. 숫자 기대값이나 과거 형식 추측은 넣지 않는다.
export const REALTY_INCOME_DOCUMENTS = {
  '0000726728-26-000009': { document_name: 'o-991q42025.htm', published_at: '2026-02-24',
    year: 2025, fiscal_period: 'Q4', month: 12, day: 31, second_scope: 'annual', second_months: 12 },
  '0000726728-26-000044': { document_name: 'o-991q22026.htm', published_at: '2026-08-05',
    year: 2026, fiscal_period: 'Q2', month: 6, day: 30, second_scope: 'ytd', second_months: 6 }
};
export const REALTY_INCOME_METRICS = [
  { metric_code: 'FFO', display_name: 'Funds From Operations', section: 'ffo',
    common: 'FFO available to common stockholders', diluted: 'Diluted FFO', shares: 'FFO per common share:',
    notes: 'Nareit FFO 정의를 사용한 회사 공시값. GAAP에서 자체 재계산하지 않는다.' },
  { metric_code: 'NORMALIZED_FFO', display_name: 'Normalized Funds From Operations', section: 'ffo',
    common: 'Normalized FFO available to common stockholders', diluted: 'Diluted Normalized FFO', shares: 'Normalized FFO per common share:',
    notes: '회사가 FFO에서 merger, transaction, and other costs, net를 조정한 공시값. 이전 연도 공시 여부를 추정하지 않는다.' },
  { metric_code: 'AFFO', display_name: 'Adjusted Funds From Operations', section: 'affo',
    common: 'AFFO available to common stockholders', diluted: 'Diluted AFFO', shares: 'AFFO per common share:',
    notes: 'Realty Income 고유 AFFO 조정표의 공시값. 연도별 조정항목이 달라질 수 있어 문서별 정의 버전을 유지한다.' }
];
export const REALTY_INCOME_TABLE_TITLES = {
  ffo: 'FUNDS FROM OPERATIONS (FFO) AND NORMALIZED FUNDS FROM OPERATIONS (NORMALIZED FFO)',
  affo: 'ADJUSTED FUNDS FROM OPERATIONS (AFFO)'
};
