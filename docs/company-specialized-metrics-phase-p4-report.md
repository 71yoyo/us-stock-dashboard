# Phase P4 - Realty Income 역사 문서 형식과 대표 Legacy Adapter

## 1. 시작 상태

- 기준 HEAD: `59e0f703505831d46ff7312390a1319b1c4c5992` / `Add specialized company metrics foundation`.
- 시작 Git clean. 기존 테스트 267 PASS / 0 FAIL.
- 시작 `npm run check`, `git diff --check`, `npm run specialized:audit` PASS.
- 이번 검증은 네 PDF와 기존 두 HTML에 한정한다. 40개 분기/42개 문서 반복·전체 backfill·운영 DB 접속은 하지 않았다.

## 2. 조사한 대표 문서

| Period | Source | Format | FFO | Norm FFO | AFFO | Standalone/YTD |
| --- | --- | --- | --- | --- | --- | --- |
| Q4/FY2016 | 공식 IR PDF | 별도 주당행 / diluted total 없음 | 있음 | not_reported | 있음 | Q4 + Annual, 각각 현재/비교연도 |
| Q2 2019 | 공식 IR PDF + SEC EX-99.2 wrapper 대조 | 별도 주당행 / diluted total 있음 | 있음 | not_reported | 있음 | Q2 + 6M YTD, 각각 현재/비교연도 |
| Q2 2021 | 공식 IR PDF, EX-99.2 표시 | Normalized + 공동 basic/diluted 주당행 | 있음 | 있음 | 있음 | Q2 + 6M YTD, 각각 현재/비교연도 |
| Q2 2024 | 공식 IR PDF + SEC EX-99.2 wrapper 대조 | FFO 별도 / NFFO·AFFO 공동 주당행 | 있음 | 있음 | 있음 | Q2 + 6M YTD, 각각 현재/비교연도 |
| Q4/FY2025 | SEC EX-99.1 HTML | P3 SEC HTML | 있음 | 있음 | 있음 | Q4 + Annual |
| Q2 2026 | SEC EX-99.1 HTML | P3 SEC HTML | 있음 | 있음 | 있음 | Q2 + 6M YTD |

대표 기간 선택은 요청 범위 내 Q2 2019 / Q2 2021 / Q2 2024다. 서로 다른 주당행·단위·Normalized 구조를 비교하기 위해 선택했다.

### 공식 출처·문서 메타데이터

- 2016: [Q4 2016 Supplemental](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2016/q4/Realty-Income-Q4-16-Supplemental-Information.pdf). 27쪽, FFO 5쪽 / AFFO 6쪽. 연결 earnings 8-K 일자 2017-02-22는 PDF 2쪽에서 확인. IR PDF 자체의 accession과 exhibit는 미확인하여 null이며 EX-99.1이라고 추정하지 않는다.
- 2019: [Q2 2019 Supplemental](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2019/q2/Realty-Income-Q2-2019-Supplemental-Information.pdf). 29쪽, FFO 5쪽 / AFFO 6쪽. 일자 2019-08-05. [SEC wrapper](https://www.sec.gov/Archives/edgar/data/726728/000072672819000075/realtyincomeq22019supple.htm), accession `0000726728-19-000075`, EX-99.2.
- 2021: [Q2 2021 Supplemental](https://www.realtyincome.com/sites/realty-income/files/realty-income/quartly-and-annual/2021/Realty-Income-Q2-2021-Supplemental-Information-8.2.2021-new.pdf). 33쪽, FFO/Normalized FFO 7쪽 / AFFO 8쪽 / 정의 32~33쪽. 일자 2021-08-02 및 EX-99.2는 PDF 내부에서 확인. accession은 미확인으로 null.
- 2024: [Q2 2024 Supplemental](https://www.realtyincome.com/sites/realty-income/files/2024-08/realty-income-q2-2024-supplemental-information.pdf). 32쪽, FFO/Normalized FFO 5쪽 / AFFO 6쪽 / 정의 30~31쪽. 일자 2024-08-05. [SEC wrapper](https://www.sec.gov/Archives/edgar/data/726728/000072672824000114/realtyincomeq22024supple.htm), accession `0000726728-24-000114`, EX-99.2.
- FY2025: [SEC HTML](https://www.sec.gov/Archives/edgar/data/726728/000072672826000009/o-991q42025.htm), accession `0000726728-26-000009`, EX-99.1, 2026-02-24.
- 2026 Q2: [SEC HTML](https://www.sec.gov/Archives/edgar/data/726728/000072672826000044/o-991q22026.htm), accession `0000726728-26-000044`, EX-99.1, 2026-08-05.

모든 문서 발행회사는 Realty Income Corporation, 소유 정의 기준은 `CIK0000726728`. PDF는 텍스트 추출 가능하며 네 숫자 열과 행 위치를 Poppler 렌더링으로 직접 확인했다. 일부 SEC supplemental wrapper는 이미지 슬라이드 형식이므로 URL 확장자가 .htm이라고 P3의 구조화 HTML 표로 판단하지 않는다. 현대 두 HTML은 고정 쪽번호가 없어 표 제목/section을 provenance로 사용한다.

표 제목/행 label: 2016·2019는 `Funds From Operations (FFO)` / `Adjusted Funds From Operations (AFFO)`, 2019 AFFO 총액에는 `Total` 접두사가 있다. 2021·2024는 `FFO and Normalized FFO (1)` / `AFFO (1)`이고 FFO 총액이 Normalized 조정 시작점에 반복된다. 2016·2019·2024는 기간 그룹→날짜→연도의 3줄 머리글, 2021은 기간+날짜→연도의 2줄 머리글이다.

## 3. Format Generation

| 이름 | 확인한 대표 / 추정 적용 후보 | 복수 fingerprint | parser |
| --- | --- | --- | --- |
| `REALTY_INCOME_PDF_SEPARATE_NO_DILUTED_TOTAL` | 2016 Q4; 초기 legacy 후보 | 두 표 제목, 4개 연도열, 기간 그룹, separate Basic/Diluted, diluted total·Normalized 부재 | PDF text adapter |
| `REALTY_INCOME_PDF_SEPARATE_DILUTED_TOTAL` | 2019 Q2; 중간 legacy 후보 | 위 요소 + Diluted FFO/AFFO 총액, 별도 주당행, Normalized 부재 | PDF text adapter |
| `REALTY_INCOME_PDF_NORMALIZED_JOINT_SHARES` | 2021 Q2; Normalized 도입 이후 공동 주당행 후보 | Normalized 총액, 반복 FFO 조정 시작점, 세 metric 공동 basic/diluted 행 | PDF text adapter |
| `REALTY_INCOME_PDF_NORMALIZED_MIXED_SHARES` | 2024 Q2; 최근 PDF 후보 | Normalized 총액, FFO 별도 주당행 + NFFO/AFFO 공동행 | PDF text adapter |
| `REALTY_INCOME_SEC_HTML_V1` | 기존 FY2025 / 2026 Q2 | 승인 accession/CIK + HTML table + diluted FFO/AFFO, 이후 P3 기간/colspan 검증 | 기존 P3 parser 그대로 |

연도는 출처/기간 확인에만 사용한다. 형식 자체는 실제 표 조합으로 선택한다. 세대 시작/종료 연도는 아직 확정할 수 없으며 중간 연도를 자동 승인하지 않는다.

## 4. 2016 결과

| metric | Q4 total USD | FY total USD | Q4 diluted/share | FY basic/share | FY diluted/share |
| --- | ---: | ---: | ---: | ---: | ---: |
| FFO | 199,833,000 | 735,395,000 | 0.77 | 2.88 | 2.88 |
| AFFO | 192,964,000 | 736,374,000 | 0.75 | 2.89 | 2.88 |

24 records = 2 metric × 3 basis × 4열. 현재연도 12건만 공식 expected 직접 대조로 validated, 비교연도 12건 parsed. Normalized FFO와 두 diluted total은 `not_reported/value:null` availability로 기록하며 가짜 numeric row/definition은 만들지 않는다.

## 5. 2018/2019 결과

2019 Q2를 선택했다. common FFO 총액 Q2 251,489,000 / 6M 497,164,000 USD, common AFFO 총액 253,935,000 / 502,669,000 USD. Diluted FFO와 AFFO 총액은 별도 basis이며 주당값과 교환하지 않는다. FFO diluted/share Q2 0.81 / YTD 1.62, AFFO diluted/share 0.82 / 1.63. 32 records, 현재연도 16건 validated / 비교연도 16건 parsed. Normalized FFO 미공시.

## 6. 2021 결과

Q2 common FFO 314,375,000 / Normalized FFO 327,673,000 / AFFO 327,647,000 USD. 6M common FFO 582,082,000 / Normalized FFO 595,380,000 / AFFO 645,869,000 USD. Q2 diluted/share 0.84 / 0.88 / 0.88. 각 주당값은 basic와 diluted를 같이 명시한 원문 행에서 읽고 공동 공시라는 provenance를 남겼다. 48 records 중 24 validated / 24 parsed.

## 7. 2023/2024 결과

2024 Q2를 선택했다. Q2 common FFO 929,133,000 / Normalized FFO 931,887,000 / AFFO 921,074,000 USD. YTD 1,714,816,000 / 1,811,674,000 / 1,783,945,000 USD. Q2 diluted/share 1.07 / 1.07 / 1.06. 비교 2023 YTD FFO basic 2.06 / diluted 2.05도 각각 그대로 유지한다. 48 records 중 24 validated / 24 parsed. 하나의 PDF 추출 엔진 안에서 share-row 전략을 분기했으며 P3 HTML parser는 적용하지 않았다.

## 8. 2025/2026 Regression

adapter의 현대 분기는 기존 `parseRealtyIncomeHtml`에 그대로 위임한다. direct parser와 adapter의 definitions/records/sources/status 전체 deep equality PASS. P3의 공식 expected 36건, 96 records / 6 definitions / 96 provenance 및 상태 36 validated / 60 parsed 유지.

## 9. VEREIT/Wrong Issuer 방지

[공식 자료실](https://www.realtyincome.com/investors/quarterly-and-annual-results)의 2021 VEREIT 자료 혼입 위험을 고려했다. synthetic VEREIT 소개, 다른 CIK, 다른 issuer, 다른 ticker, O 문자열만 같은 타회사, 다른 CIK의 SEC URL 모두 `rejected/wrong_issuer`, records 0. 정상 2021 Realty Income 문서의 VEREIT 합병 정의는 허용한다. 소개 첫 회사명 + NYSE 종목, 승인 URL/hash, CIK/issuer/accession 등을 조합하며 전역 VEREIT 문자열 차단은 하지 않는다. 실제 VEREIT PDF를 다운로드/파싱한 것은 아니다.

## 10. Adapter 구조

`detectDocumentFormat` → `parseRealtyIncomeDocument` → PDF extraction(행/네 열/기간/basis 중간 observations) → `normalizeHistoricalMetrics` → 기존 `saveSpecializedMetrics`.

기존 P3 HTML은 결과를 바꾸지 않기 위해 위임 예외를 둔다. P4의 모든 PDF generation은 동일 normalizer를 쓴다. Worker 라우트·큐·scheduler에는 연결하지 않았다.

## 11. PDF 처리 전략

`pdfplumber` text extraction + Poppler로 FFO/AFFO 8개 페이지 시각 대조. `scripts/realty-income-pdf-excerpt.py`는 승인된 PDF **한 개**만 읽어 JSON stdout을 반환하며 원문 hash/페이지 수를 확인한다. 네 PDF에서 재추출한 excerpt와 fixture는 내용/hash 4/4 정확히 일치했다. OCR 0회. 텍스트 없음·미지원 구조는 needs_review이며 부분 성공 저장을 막는다.

원본 PDF는 repo 밖 임시 소스 캐시에만 있다. repo에는 identity 최소 세 줄, 표 두 페이지 발췌, 필요한 glossary 일부, source metadata, expected JSON만 저장했다. PDF 전체·스크린샷·임시 다운로드·환경변수·실제 이메일·API key는 변경 파일에 없다.

## 12. Unit 차이

2016/2019/2021의 `(dollars in thousands, except per share amounts)`는 금액에만 천 단위를 적용하고 원문 weighted shares는 258,373,179 같은 전체 주식수다. 2024의 `(in thousands, except per share amounts)`는 금액/주식수 천 단위이며 870,319 같은 주식수를 공시한다.

각 표의 단위 문구와 달러 기호를 확인한 뒤 총액 `USD thousand ×1000 → USD`, 주당 `USD/share ×1 → USD/share`로 정규화했다. 2016 FY FFO raw 735395 → 735395000 USD, FY AFFO diluted/share raw 2.88 → 2.88 USD/share. Weighted share count의 원 단위는 source JSON에 남기되 지표 계산/주당값 역산에는 전혀 사용하지 않는다. 미지원 million 단위는 자동 변환하지 않고 needs_review.

## 13. Period Scope

2016 Q4 `10-01~12-31`와 Annual `01-01~12-31`를 별도 저장. Q2 자료는 standalone `04-01~06-30` / YTD `01-01~06-30`를 분리하고 각 현재/비교연도도 분리. 기간 그룹의 좌우 순서/날짜/연도 4열을 검증한다. FY−9M, YTD 차감, TTM 생성, 미공시 scope 생성 없음.

## 14. Definition Version

legacy 정의 8개: FFO 2개 / Normalized FFO 2개 / AFFO 4개.

- FFO: 2016의 real estate assets와 2019 이후 depreciable real estate assets라는 공시 범위 차이를 보수적으로 분리. 실제 회계정책 변경 시점까지 확인했다는 뜻은 아니다. 2019/2021/2024는 같은 FFO 정의/버전/정의 근거를 공유한다.
- Normalized FFO: VEREIT 예정 합병 비용 제외 / merger and integration 비용 제외를 분리한다.
- AFFO: 공시된 조정 시작점이 두 FFO 범위인지, VEREIT 비용 제외 Normalized FFO인지, merger/integration 비용 제외 Normalized FFO인지에 따라 분리한다. 정의의 고유 항목 조정 문구와 실제 reconciliation 표를 provenance에 보존한다.
- 동일 레이아웃 여부/발표연도만으로 정의 버전을 추가하지 않는다. 조정항목의 연도별 차이가 없어졌다고 보장하지도 않는다.
- P3의 기존 문서 기반 `EX99.1-2025-Q4` / `EX99.1-2026-Q2` 별도 정의 6개는 frozen compatibility로 그대로 유지한다. 소급 재작성/중복 정리/정의 자동 merge는 하지 않았다.

전체 로컬 검증 DB definitions 14개 = legacy 의미 구분 8개 + P3 frozen 6개. 동일 FFO의 다른 layout은 중복 definition으로 생성되지 않았다.

## 15. Validation 상태

legacy: 152 records 중 수동 공식 expected 76건만 validated / 비교연도 76건 parsed. P3 포함: 248 records 중 112 validated / 136 parsed. needs_review/rejected 사례는 numeric rows 0, store 저장 거부 PASS. 별도 검증 호출 없이 parsed를 validated로 올리는 코드가 없다. 미공시 정보는 numeric NULL row가 아닌 각 source metadata와 결과 availability에 보존한다.

## 16. 기존 P3 Regression

P3 parser/mapping/fixtures/store 및 migration 파일 변경 0. P3를 먼저 저장하고 legacy를 저장/재저장해도 P3 전체 행 deep equality 유지. financial_metrics/company_classification의 기존 전체 행 digest 전후 동일. UI/financial-chart.js/SEC ingestion/scheduler/production config diff 없음.

## 17. Test

- 기존 267 / 신규 43 / 총 310 PASS / FAIL 0 / skipped 0.
- `npm run check`: PASS.
- `git diff --check`: PASS (package.json의 Git LF→CRLF 안내만 있으며 whitespace 오류 없음).
- `npm run specialized:audit`: PASS, 기존 36 official expected 일치.
- `npm run specialized:historical-audit`: PASS, 대표 6문서/248 records/14 definitions/248 provenance, round-trip/idempotent/protected digest/P3 유지.
- 메모리 SQLite Fresh 0001~0018 및 Existing 0017→0018 검증 PASS. 운영 migration을 실행하지 않았다.
- PDF 재추출 네 개: excerpt/hash 정확히 일치. 브라우저 실행은 UI가 금지 범위이고 미변경이라 하지 않았다.

## 18. 수정 파일

- `worker/src/reit/realty-income-document-formats.js`
- `worker/src/reit/realty-income-document-adapter.js`
- `worker/src/reit/realty-income-pdf-parser.js`
- `worker/src/reit/realty-income-normalizer.js`
- `scripts/realty-income-pdf-excerpt.py`
- `scripts/realty-income-historical-audit.mjs`
- `tests/helpers/realty-income-historical-fixtures.js`
- `tests/realty-income-historical.test.js`
- `tests/fixtures/realty-income-historical/{fy2016,q2-2019,q2-2021,q2-2024,official-expected}.json`
- `package.json` (check 및 offline audit 명령만 추가)
- `docs/company-specialized-metrics-phase-p4-report.md`

## 19. Production 변경

production migration / DB write / Worker deploy / Pages deploy / UI 변경 / commit / push: 모두 NO. BQ/FMP/Massive/Moomoo 호출 NO. 전체 2016~2025 backfill NO. production DB 검증을 했다고 주장하지 않는다.

## 20. 0018 Schema 충분 여부

YES. 기존 정의/값/출처 테이블로 의미별 definition, scope/basis, format_id/extraction/미공시 availability/정의 근거를 round-trip 할 수 있다. 추가 adapter 정보는 `source_metadata_json`으로 보존했다. 0018 수정 및 신규 migration 없음, [SCHEMA GAP] 없음. 개별 미공시 값을 SQL numeric row로 저장할 필요가 없다.

## 21. Historical Format Coverage 추정

2016 전후 초기 PDF → no-diluted-total 후보 / 2019 전후 PDF → separate-diluted-total 후보 / 2021 전후 → Normalized-joint 후보 / 2024 전후 → Normalized-mixed 후보 / 검증된 FY2025·2026Q2 HTML → P3 adapter.

이것은 **네 역사 PDF의 관측 결과에 따른 후보 분류**이지 2016~2018·2019~2022 같은 연속 구간을 검증했다는 뜻이 아니다. coverage 분모/비율, 세대 전환 연도, Q1/Q3 지원 가능성을 계산하거나 확정하지 않았다. unknown 형식/URL은 needs_review.

## 22. 다음 단계

전체 2016~2025 dry-run을 즉시 실행할 준비: **NO**. 우선 새 Phase에서 문서 목록/회사 identity/출처 승인과 Q1/Q3 및 중간 변형의 최소 추가 표본 검증이 필요하다. 현재 adapter는 네 승인 PDF의 Q2/Q4 기간 계약을 의도적으로 제한한다. 이것은 P4 대표 검증 실패가 아니라 무검증 대량 적용을 막는 안전 경계다. 이후 읽기 전용 전체 dry-run이 가능해져도 실제 운영 backfill은 별도 승인 대상이다.

| 최종 질문 | 답 |
| --- | --- |
| 1. 대표 역사 format generation 구분 가능 | YES |
| 2. 대표 2016 FFO 안전 추출 | YES |
| 3. 대표 2016 AFFO 안전 추출 | YES |
| 4. 없는 Normalized FFO를 만들지 않음 | YES |
| 5. 2021 wrong issuer와 O 구분 | YES (synthetic wrong issuer 검증) |
| 6. 검증한 표의 단위 올바르게 정규화 | YES |
| 7. quarterly/YTD/annual 구분 | YES |
| 8. P3 regression 없음 | YES |
| 9. 0018로 대표 역사 데이터 저장 충분 | YES |
| 10. 즉시 전체 2016~2025 dry-run 시작 | NO (추가 inventory/표본/승인 필요) |
