# Phase P5A: Realty Income 문서 inventory 및 Q1/Q3 표본 검증

## 1. 시작 상태

checkpoint: 861b350030d2947d7bec24f0dffae9cf2188a360 (Add Realty Income historical document adapters).
시작 Git clean. npm test 310 PASS / 0 FAIL, npm run check, git diff --check, specialized:audit, specialized:historical-audit 모두 PASS 후 작업 시작.

## 2. 전체 문서 Inventory

공식 IR archive: https://www.realtyincome.com/investors/quarterly-and-annual-results
2016-2025 O 분기 문서 40개, 각 연도 Q1/Q2/Q3/Q4/FY 4/4. 별도 타 회사 6개와 2026 Q1/Q2 참고 링크 2개를 구분한다.
Q4 supplemental과 같은 archive card의 annual filing 링크 관계 10개를 기록했다. Q4 3개월과 FY 12개월은 별도 scope이고 annual report/10-K는 별도 문서다.
inventory.json에는 URL/출처/기간/issuer/CIK/발표·공시 날짜/accession/exhibit/형식/후보 adapter/상태/주석을 보존했다.
미확인 날짜/accession/형식/availability는 null이다. available=true는 실제 확보·adapter 검증한 9개 PDF에만 쓴다. 링크 존재 자체를 HTTP 성공으로 취급하지 않는다.

## 3. Inventory Status

40개 O IR PDF: SUPPORTED 9 / LIKELY_SUPPORTED 0 / UNKNOWN_FORMAT 31 / MISSING 0 / NEEDS_REVIEW 0 / WRONG_ISSUER 0.
별도 제외 목록: WRONG_ISSUER 6 (2021 VEREIT Q1/Q2/Q3 및 2023 Spirit Realty Q1/Q2/Q3).
2026 Q1/Q2 IR PDF는 참고 목록으로만 기록하며 adapter 미검증이다. 기존 P3 SEC HTML 2025 Q4/FY 및 2026 Q2의 검증 사실은 별도 sec_period_references에 기록한다.
동일 회계기간 SEC earnings exhibit이 있다는 사실을 IR PDF 자체의 parser 검증으로 오인하지 않는다.

## 4. 추가 검증 샘플

2017 Q1, 2018 Q3, 2020 Q3, 2022 Q3, 2023 Q3.
2020/2022는 허용된 선택지의 Q3를 택해 9M YTD를 직접 검증하고 2022 원문-2023 비교 열을 실제로 대조했다.
다섯 원문 PDF의 FFO/AFFO 표 10페이지, 2022/2023 Glossary 4페이지, 동일 분기 earnings release 첫 페이지의 발표 날짜를 이미지로 확인했다.
PDF 스킬에 따라 텍스트 추출만으로 확정하지 않고 표 제목·열의 좌우 위치·기간·단위·footnote를 시각 대조했다. OCR 0회.
다섯 원문 hash와 최소 발췌 hash의 재현 5/5 PASS. 전체 PDF/이미지/다운로드 HTML은 repo에 추가하지 않았다.

## 5. 2017 Q1 결과

A-J / 12 records: current-year 6 validated, comparative 6 parsed.
총액 USD thousand: FFO 187,213 / AFFO 201,336.
basic+diluted 공동 주당값 USD/share: FFO 0.71 / AFFO 0.76.
diluted total과 NFFO는 공시행이 없어 not_reported, 값/정의 생성 또는 역산 없음.
기간 2017/2016 Jan1-Mar31 한 그룹만 공시.
발표일/공시 언급일 2017-04-25. SEC 동일 표와 날짜 확인: 0001104659-17-025905 / EX-99.2.
https://www.sec.gov/Archives/edgar/data/726728/000110465917025905/a17-11645_1ex99d2.htm

## 6. 2018 Q3 결과

B-M / 32 records: 16 validated + 16 parsed.
quarterly common total FFO/AFFO: 234,550 / 236,195; diluted total 234,767 / 236,422.
quarterly diluted/share: FFO 0.81 / AFFO 0.81.
9M common total FFO/AFFO: 685,514 / 687,744; diluted/share 2.39 / 2.40.
FFO joint share 행, AFFO basic/diluted 별도 행(콜론 없음). NFFO not_reported.
FFO 손상 범위의 depreciable 문구를 원문에서 확인. 정확한 전환 시작 연도를 주장하지 않는다.
발표·공시 언급일 2018-10-31. SEC accession/exhibit는 미확인 null.

## 7. 2020 Q3 결과

B / 32 records: 16 validated + 16 parsed.
quarterly common total FFO/AFFO: 282,978 / 282,509; diluted total 283,323 / 282,856.
quarterly diluted/share: FFO 0.82 / AFFO 0.81; AFFO basic 0.82와 구별.
9M common total FFO/AFFO: 848,419 / 874,972; diluted/share 2.48 / 2.55.
FFO/AFFO separate share 행 및 diluted total 공시. NFFO not_reported.
COVID 설명으로 표 위치가 p9/p10이지만 페이지 번호만으로 format을 고르지 않는다.
발표·공시 언급일 2020-11-02, 표지 EX-99.2; accession null.

## 8. 2022 Q3 결과

C / 48 records: 24 validated + 24 parsed.
quarterly FFO/NFFO/AFFO common total: 597,154 / 600,900 / 603,566.
quarterly diluted total: 598,139 / 601,885 / 604,572.
quarterly diluted/share: 0.97 / 0.97 / 0.98.
9M common total: 1,807,385 / 1,820,379 / 1,767,392; diluted/share 2.99 / 3.01 / 2.92.
NFFO merger/integration 제외 정의와 AFFO의 NFFO 시작점을 별도 보존.
단위 except per share and share count data: 총액 ×1000, 주당값 ×1, weighted shares는 실제 shares.
발표·공시 언급일 2022-11-02, EX-99.2; accession null.

## 9. 2023 Q3 결과

C-M / 48 records: 24 validated + 24 parsed.
quarterly FFO/NFFO/AFFO common total: 736,146 / 739,030 / 721,370.
quarterly diluted total: 737,521 / 740,405 / 722,727.
quarterly diluted/share: 1.04 / 1.04 / 1.02.
9M common total: 2,108,422 / 2,112,954 / 2,043,836; diluted/share 3.09 / 3.10 / 2.99.
AFFO YTD basic 3.00과 diluted 2.99를 분리. FFO/NFFO joint와 AFFO separate를 구분.
단위 except per share amounts: weighted shares는 shares thousand로 보존. 역산하지 않는다.
발표·공시 언급일 2023-11-06, 0000726728-23-000111 / EX-99.2.
https://www.sec.gov/Archives/edgar/data/726728/000072672823000111/realtyincomeq32023supple.htm

## 10. 새 Format 발견 여부

[NEW FORMAT] 3종. 제목+총액 행+주당값 행+기간 열+회사+원문 hash 복수 fingerprint를 사용한다.

- A-J: REALTY_INCOME_PDF_JOINT_NO_DILUTED_TOTAL. 2017 Q1. 기존 A의 separate share와 달리 joint share, diluted total 없음.
- B-M: REALTY_INCOME_PDF_JOINT_FFO_SEPARATE_AFFO. 2018 Q3. 기존 B와 달리 FFO joint / AFFO separate, diluted total 있음.
- C-M: REALTY_INCOME_PDF_NORMALIZED_JOINT_FFO_SEPARATE_AFFO. 2023 Q3. 기존 C와 달리 AFFO가 separate; FFO/NFFO는 joint.

서로 다른 연도/분기에 적용 가능한 행 구조 규칙이며 특정 expected 숫자 또는 연도만으로 선택하지 않는다.
추가 승인은 확인된 다섯 URL/hash/회사/기간에 한정한다. unknown 문서는 SOURCE_UNSUPPORTED/FORMAT_UNSUPPORTED 등으로 needs_review, 부분 값 없음.
2022 share-count 단위 예외는 layout과 구분된 unit 처리 확장이다. 신규 definition version 또는 schema 변경은 없다.

## 11. Format Transition Map

검증된 점만 연결한다. 아래는 연속 연도 전체 지원을 의미하지 않는다.

| 검증 문서 | format |
| --- | --- |
| 2016 Q4/FY | A |
| 2017 Q1 | A-J |
| 2018 Q3 | B-M |
| 2019 Q2 | B |
| 2020 Q3 | B |
| 2021 Q2 | C |
| 2022 Q3 | C (share count 단위 예외) |
| 2023 Q3 | C-M |
| 2024 Q2 | D |
| 2025 Q4/FY / 2026 Q2 SEC earnings exhibit | SEC_HTML_V1 (P3) |

중간 미검증 PDF는 UNKNOWN. 같은 해여도 연도만으로 LIKELY/SUPPORTED를 부여하지 않았다.

## 12. Q1 처리

2017 Q1은 current/comparative 두 연도 열을 한 번만 제공한다. Jan1-Mar31은 YTD와 경제적으로 같지만 원문에는 별도 YTD 그룹이 없으므로 quarterly로만 저장한다.
공동 basic/diluted 주당값은 두 basis를 공시했다는 의미이지 Q1/YTD 중복이 아니다.
합성 반복 머리글/4열은 추측해서 두 그룹을 생성하지 않고 needs_review. 향후 실제 Q1/YTD 반복 공시는 canonical quarterly 한 값과 별도 provenance observation로 검토해야 하며 이번에 scope/저장 정책을 바꾸지 않았다.

## 13. Q3 standalone/YTD 처리

왼쪽 Three months ended: Jul1-Sep30 quarterly.
오른쪽 Nine months ended: Jan1-Sep30 ytd.
정확한 머리글/현재·비교 연도 순서/날짜/열 수를 재검증한다. 그룹 반전이나 숫자 열 누락은 전체 needs_review.
quarter 값에서 YTD를 빼거나 YTD에서 quarter를 계산하지 않았다.

## 14. Normalized FFO coverage

40개 IR 문서별 YES/NO/UNKNOWN는 아래 support matrix 마지막 열 및 inventory.json에 기록했다.
NO: 2016 Q4, 2017 Q1, 2018 Q3, 2019 Q2, 2020 Q3의 대표 조정표.
YES: 2021 Q2, 2022 Q3, 2023 Q3, 2024 Q2.
나머지 31 PDF는 UNKNOWN. 별도 P3 2025 Q4/FY 및 2026 Q2 SEC 조정표는 YES.
표본상 2020 Q3 미공시→2021 Q2 공시 확인 구간이지만, 정확한 최초 공시일/연도는 확정하지 않는다.

## 15. Comparison-year / Restatement 관찰

2022 Q3 원문 ↔ 2023 Q3의 2022 비교 열: 동일 definition/scope/basis 24건 모두 일치, canonical delta 0.
예: Q3 FFO common total 597,154, Q3 AFFO common total 603,566, 9M NFFO diluted/share 3.01 (양 문서 동일).

조정항목/주식수 표시는 바뀐 점도 보존한다:
2022 9M Other adjustments 24,434 → 2023 비교 열 25,318: raw delta +884 USD thousand.
원문의 Straight-line payments from cross-currency swaps 884가 후속 표의 Other adjustments 범주에 들어간 것으로 해석 가능한 표시 재분류다. 합계 AFFO 1,767,392는 동일하며 이를 AFFO restatement로 단정하지 않는다.
2022 Q3 basic weighted shares 617,511,609 shares → 2023 비교값 617,512 thousand shares: 표시 단위/반올림 차이. FFO/AFFO 주당값을 이 주식수로 역산하지 않는다.

canonical 값의 실제 불일치는 이번 24건에서 발견되지 않았다.
합성 차이 +1,000 USD 테스트로 restated/comparative difference 분류/기간/양쪽 URL/원값/후속값/delta 보고를 검증했다. 실제 restatement가 발견됐다고 주장하지 않는다. 자동 overwrite 없음.

## 16. Duplicate 방지

기존 metricRecordKey: ticker/metric/definition owner+version/scope/start/end/value basis/share basis/attribution basis.
동일 값+동일 key가 원문/후속 비교 열에 반복되면 값 행 하나 + provenance 두 개.
추가 다섯 표본 172 observations → 148 unique values + 172 provenance (중복 24).
동일 값 재실행은 idempotent, parsed 재저장이 validated를 낮추지 않는다.
실제 값 충돌은 기존 store가 batch 실행 전에 거절하고 기존 값/출처를 보존. canonical 선택/overwrite 정책 변경 0.
IR↔SEC 다중 출처의 저장 계약은 기존 P3 테스트로 유지되며 이번 SEC 대응 URL 두 건은 동일 표/기간 확인 근거만 기록했다. 미다운로드 SEC 원문 hash를 만들어내지 않았다.

## 17. Issuer 검증

O PDF 소개의 Realty Income + New York Stock Exchange + symbol O, metadata CIK 0000726728, 승인 URL/원문 hash/기간/footer를 함께 확인.
2021 VEREIT 자료 3개 및 2023 Spirit Realty 자료 3개는 archive issuer 하위 heading 기준 WRONG_ISSUER로 제외.
VEREIT/Spirit 자체 issuer는 거절, Realty Income 설명의 VEREIT 합병 문구는 허용. 미확인 타 회사 CIK는 null.

## 18. Adapter Support Matrix

A = REALTY_INCOME_PDF_SEPARATE_NO_DILUTED_TOTAL
A-J = REALTY_INCOME_PDF_JOINT_NO_DILUTED_TOTAL
B = REALTY_INCOME_PDF_SEPARATE_DILUTED_TOTAL
B-M = REALTY_INCOME_PDF_JOINT_FFO_SEPARATE_AFFO
C = REALTY_INCOME_PDF_NORMALIZED_JOINT_SHARES
C-M = REALTY_INCOME_PDF_NORMALIZED_JOINT_FFO_SEPARATE_AFFO
D = REALTY_INCOME_PDF_NORMALIZED_MIXED_SHARES

각 URL/문서명/메타데이터는 tests/fixtures/realty-income-p5a/inventory.json에 대응한다.
null은 미확인이지 미공시/실패 확정이 아니다.

| Document | Detected format | Adapter | Status | Normalized FFO |
| --- | --- | --- | --- | --- |
| 2016 Q1 | null | null | UNKNOWN | UNKNOWN |
| 2016 Q2 | null | null | UNKNOWN | UNKNOWN |
| 2016 Q3 | null | null | UNKNOWN | UNKNOWN |
| 2016 Q4/FY | A | parseRealtyIncomeDocument | VERIFIED | NO |
| 2017 Q1 | A-J | parseRealtyIncomeDocument | VERIFIED | NO |
| 2017 Q2 | null | null | UNKNOWN | UNKNOWN |
| 2017 Q3 | null | null | UNKNOWN | UNKNOWN |
| 2017 Q4/FY | null | null | UNKNOWN | UNKNOWN |
| 2018 Q1 | null | null | UNKNOWN | UNKNOWN |
| 2018 Q2 | null | null | UNKNOWN | UNKNOWN |
| 2018 Q3 | B-M | parseRealtyIncomeDocument | VERIFIED | NO |
| 2018 Q4/FY | null | null | UNKNOWN | UNKNOWN |
| 2019 Q1 | null | null | UNKNOWN | UNKNOWN |
| 2019 Q2 | B | parseRealtyIncomeDocument | VERIFIED | NO |
| 2019 Q3 | null | null | UNKNOWN | UNKNOWN |
| 2019 Q4/FY | null | null | UNKNOWN | UNKNOWN |
| 2020 Q1 | null | null | UNKNOWN | UNKNOWN |
| 2020 Q2 | null | null | UNKNOWN | UNKNOWN |
| 2020 Q3 | B | parseRealtyIncomeDocument | VERIFIED | NO |
| 2020 Q4/FY | null | null | UNKNOWN | UNKNOWN |
| 2021 Q1 | null | null | UNKNOWN | UNKNOWN |
| 2021 Q2 | C | parseRealtyIncomeDocument | VERIFIED | YES |
| 2021 Q3 | null | null | UNKNOWN | UNKNOWN |
| 2021 Q4/FY | null | null | UNKNOWN | UNKNOWN |
| 2022 Q1 | null | null | UNKNOWN | UNKNOWN |
| 2022 Q2 | null | null | UNKNOWN | UNKNOWN |
| 2022 Q3 | C | parseRealtyIncomeDocument | VERIFIED | YES |
| 2022 Q4/FY | null | null | UNKNOWN | UNKNOWN |
| 2023 Q1 | null | null | UNKNOWN | UNKNOWN |
| 2023 Q2 | null | null | UNKNOWN | UNKNOWN |
| 2023 Q3 | C-M | parseRealtyIncomeDocument | VERIFIED | YES |
| 2023 Q4/FY | null | null | UNKNOWN | UNKNOWN |
| 2024 Q1 | null | null | UNKNOWN | UNKNOWN |
| 2024 Q2 | D | parseRealtyIncomeDocument | VERIFIED | YES |
| 2024 Q3 | null | null | UNKNOWN | UNKNOWN |
| 2024 Q4/FY | null | null | UNKNOWN | UNKNOWN |
| 2025 Q1 | null | null | UNKNOWN | UNKNOWN |
| 2025 Q2 | null | null | UNKNOWN | UNKNOWN |
| 2025 Q3 | null | null | UNKNOWN | UNKNOWN |
| 2025 Q4/FY | null | null | UNKNOWN | UNKNOWN |

## 19. 0018 schema 충분 여부

YES. 기존 long-format 값 key + immutable definition + 복수 source metadata 구조로 중복 비교 열과 출처를 저장할 수 있다.
Q1 원문은 단일 그룹이라 별도 schema 필요 없음.
검토해야 하는 충돌을 검토 없이 둘 다 canonical 값으로 저장하거나 overwrite하는 것은 허용하지 않는다. 이런 경우 read-only 보고서로 남기는 현재 정책을 유지한다.
0018/기존 migration 수정 0, 새 migration 없음.

## 20. P3/P4 Regression

P3: 96 records / 6 definitions / 96 provenance, official expected 36 유지.
P3+P4: 248 records / 14 definitions / 248 provenance / 112 validated / 136 parsed 유지.
P5 표본 추가 메모리 DB: 396 unique records / 14 definitions / 420 provenance / 198 validated / 198 parsed.
기존 248 records의 값/정의/출처 snapshot 완전 동일. financial_metrics/company_classification digest 변화 0.
P3 parser/store/mapping, P4 fixture/expected, 기존 schema, scheduler, UI는 수정하지 않았다.

## 21. Test

기존 310 + 신규 42 = 352 PASS / 0 FAIL.
npm run check PASS.
git diff --check PASS.
specialized:audit PASS.
specialized:historical-audit PASS.
specialized:inventory-audit PASS.
추가 PDF helper 단일 문서 hash 재현 5/5 PASS.
신규 테스트는 inventory parsing/status, Q1/Q3 detection/기간, 세대 전환, 단위, wrong issuer, unknown, NFFO not_reported, canonical 중복/실제 비교 열/합성 충돌 및 P3/P4 보호를 포함한다.

## 22. 수정 파일

수정:
- package.json (check/audit 명령)
- worker/src/reit/realty-income-document-formats.js (표본 승인/새 fingerprint)
- worker/src/reit/realty-income-pdf-parser.js (Q1/Q3 열·단위·share 행)
- worker/src/reit/realty-income-normalizer.js (share count 단위 예외)

추가:
- worker/src/reit/realty-income-p5a-samples.js
- scripts/realty-income-inventory.mjs
- scripts/realty-income-comparison.mjs
- scripts/realty-income-p5a-audit.mjs
- scripts/realty-income-p5a-excerpt.py
- tests/helpers/realty-income-p5a-fixtures.js
- tests/realty-income-p5a.test.js
- tests/fixtures/realty-income-p5a/{2017-q1,2018-q3,2020-q3,2022-q3,2023-q3}.json
- tests/fixtures/realty-income-p5a/official-expected.json
- tests/fixtures/realty-income-p5a/inventory.json
- tests/fixtures/realty-income-p5a/archive-excerpt.html
- docs/company-specialized-metrics-phase-p5a-report.md

20개 파일 (수정 4 + 추가 16). API key/token/실제 이메일/.dev.vars 추가 없음.
repo fixture는 최소 표/정의 발췌/직접 전사 expected/출처 JSON/구조 inventory 발췌만 포함. 전체 PDF/스크린샷/Temp 파일 없음.

## 23. Production 변경

production migration NO / production DB write NO / Worker deploy NO / Pages deploy NO / UI 변경 NO.
전체 42문서 parser loop NO / 전체 backfill NO / BQ·FMP·Massive·Moomoo 호출 NO / OCR NO / commit NO / push NO.

## 24. P5B 전체 Dry-run 준비 여부

READY: 읽기 전용 전체 문서 조사/검토 리포트 단계에 한정한다.
Q1/Q3 표본, 실제 전환 구조, issuer/unit/scope, unknown fail-closed, 중복 및 regression 안전성을 확인했다.
31개 UNKNOWN 문서가 파싱 성공한다는 의미가 아니다. 현재 승인 manifest는 검증된 PDF 9개뿐이므로 P5B에서는 미검증 문서의 URL/원문 hash/issuer/날짜/형식을 직접 확인하는 읽기 전용 절차가 선행되어야 한다.
대응 없는 문서는 needs_review로 남기고, 충돌 보고서를 보존하며 자동 저장/overwrite/운영 backfill을 실행해서는 안 된다.
운영 수집 준비 또는 backfill 승인과는 별개이며 이번에는 전체 dry-run도 실행하지 않았다.

### 최종 YES/NO

1. 2016-2025 공식 문서 inventory 생성: YES.
2. Q1 대표 문서 안전 처리: YES.
3. Q3 대표 문서 안전 처리: YES.
4. standalone/YTD 혼동 방지: YES.
5. 새로운 format 안전 탐지: YES (확인된 3종 및 unknown fail-closed).
6. wrong issuer 방지 유지: YES.
7. duplicate historical record 방지 충분: YES (충돌은 검토, overwrite 금지).
8. 기존 P3/P4 regression 없음: YES.
9. 0018 schema 충분: YES.
10. 다음 Phase 전체 read-only historical dry-run 진행 준비: YES (31개 UNKNOWN 개별 source 확인 및 needs_review 허용; 쓰기/backfill 승인 아님).
