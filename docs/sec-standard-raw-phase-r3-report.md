# REIT Metrics R3 — SEC Standard Financial Raw Fields Foundation

## 1. 시작 상태

기준/현재 HEAD: `5831bd6e125050707bc7e554459483634a3d52f9`.
시작 Git clean, 기존 테스트 722 PASS / 0 FAIL, `npm run check` 및 `git diff --check` PASS.
기존 GENERAL/BANK/REIT UI, public API, scheduler, production config는 변경하지 않는다.

Source architecture는 SEC 중심이며 BQ는 기존 R2 값의 교차검증에만 사용한다.
FMP는 `NOT VERIFIED — LOCAL CREDENTIAL UNAVAILABLE`을 유지한다. Massive를 재무 원천으로 사용하지 않는다.

## 2. 저장 구조 결정

별도 long-format 값 테이블 `sec_standard_raw_metrics`와 append-only 출처 테이블 `sec_standard_raw_provenance`를 선택했다.

| 판단 기준 | 결정 근거 |
| --- | --- |
| 시점/기간/평균 구분 | `value_kind`, `period_type`, `period_start/end`로 별도 의미를 보존 |
| 기존 PK 의미 | `financial_metrics`의 annual/quarterly PK는 off-period DEI snapshot 및 YTD를 표현할 수 없음 |
| provenance | 기존 `secSourceReference`/`secDifferenceMetadata` 재사용, 새 FK와 append-only 이력으로 확장 |
| 원본 출처 보호 | 기존 `financial_metric_provenance`에 새 raw 이름을 덮어쓰지 않음 |
| 확장 | 지표별 열 추가 없이 metric row로 확장; 허용 지표 정책은 검토된 migration으로 확장 |
| 조회 | ticker/period/end 인덱스 및 현재 source fingerprint JOIN |
| migration 안전성 | 기존 테이블 ALTER/DROP/UPDATE 없이 새 테이블/인덱스만 생성 |

PK: `(ticker, metric_name, period_type, period_start, period_end)`.
instant 시작일은 NULL PK 문제를 피하려고 빈 문자열로 명시한다.
`availability`는 `available`, `missing`, `needs_review`; 미확보 값은 NULL이며 0으로 채우지 않는다.

같은 SEC sync의 facts 객체를 받아 추출한다. 새로운 SEC/BQ/FMP/Massive 요청을 추가하지 않는다.
`SEC_STANDARD_RAW_FIELDS_ENABLED='true'`일 때만 새 저장 경로가 활성화된다. 기본은 비활성이고 운영 설정은 변경하지 않았다.
활성 경로는 migration 0020을 기존 재무 쓰기 전에 확인한다. 미적용 시 안전 중단하며 런타임에 schema를 생성하지 않는다.
기존 sync의 반환 contract와 숫자 선택/계산 코드는 유지했다.

## 3. Migration

`0020_sec_standard_raw_metrics.sql` 추가. 새 값/출처 테이블 2개 및 조회 인덱스 2개.
금지 지표는 허용 metric CHECK에 포함하지 않는다. 기존 migration 0001~0019는 수정하지 않았다.
적용 검증은 폐기 가능한 메모리 SQLite에서만 수행했다. 영속 로컬 DB와 production D1에는 적용하지 않았다.

## 4. Raw Fields

| metric | 그룹 | 직접 표준 태그 / 정책 |
| --- | --- | --- |
| shares_outstanding | point_in_time | CommonStockSharesOutstanding; 날짜를 보존한 dei:EntityCommonStockSharesOutstanding fallback |
| cash_and_cash_equivalents | point_in_time | CashAndCashEquivalentsAtCarryingValue; restricted-inclusive 대체 금지 |
| total_assets | point_in_time | Assets |
| stockholders_equity | point_in_time | StockholdersEquity; parent만 |
| equity_including_nci | point_in_time | StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest |
| weighted_average_shares_basic | period_average | WeightedAverageNumberOfSharesOutstandingBasic |
| weighted_average_shares_diluted | period_average | WeightedAverageNumberOfDilutedSharesOutstanding |
| interest_expense | period | InterestExpenseOperating, InterestExpense |
| consolidated_net_income | period | ProfitLoss; parent NetIncomeLoss 대체 금지 |
| income_tax_expense | period | IncomeTaxExpenseBenefit |
| depreciation_and_amortization | period | DepreciationDepletionAndAmortization |
| ebit | period | 검증된 3개 입력 합계 |
| ebitda | period | EBIT + 감가상각/상각 입력 |

단위는 USD 또는 shares로 명시한다. 다른 통화/단위, segment/dimensions, custom tag, 손상된 fact는 채택하지 않는다.
감가상각/상각은 위 표준 태그의 보고값이며 태그 명칭상 depletion을 포함할 수 있다. issuer별 EBITDA 정의와 같다고 일반화하지 않는다.
Market Cap 저장: NO. 가격 조정 기준 및 동일 날짜 실제 주식 수 결합 정책은 다음 별도 단계에서 검토한다.

## 5. Point-in-time

원본 end 날짜를 가진 instant row만 저장한다. annual/quarterly 기간 합계로 저장하거나 차감하지 않는다.
연간/분기 coverage는 기존 financial period end와 instant의 정확한 날짜 JOIN으로 판정한다.
DEI cover-page의 실제 날짜는 보존하고 분기 말로 이동하지 않는다. balance-sheet date와 구분하는 shareBasis를 provenance에 남긴다.
최신 제출일을 우선하고, 같은 날짜/같은 제출일에서 us-gaap actual shares가 DEI보다 우선한다.
weighted average shares는 어떤 경우에도 실제 주식 수 대체 후보가 아니다.

## 6. Period Values

원본 start/end 길이로 annual, standalone quarterly, YTD를 분리한다.
direct standalone을 우선한다. 기간 합계에만 누적 차감을 허용한다.
이번 안전 정책은 같은 tag/taxonomy/unit/scope/start 및 같은 accession의 두 원본을 요구한다.
공시 버전이 다른 누적값은 섞지 않는다. FY minus 9m도 이 조건에서만 허용한다.
두 원본, 계산식, 실제 standalone start/end 및 `ytd_difference`/`fy_minus_9m`를 보존한다.
엄격한 동일 공시 조건으로 인해 추출 coverage가 기존 느슨한 차감보다 작을 수 있으며, 임의 완화하지 않는다.

## 7. Weighted Average Shares

Annual 직접 FY 및 직접 standalone quarterly만 값으로 저장한다.
누적 평균 주식 수는 차감하지 않고, standalone을 역산하거나 평균을 실제 주식 수로 옮기지 않는다.
YTD row의 평균 항목은 명시적 NULL이다. 직접 분기 값이 없는 알려진 기간도 NULL이다.
비달력 회사 FY2027/Q2 테스트도 통과했고 달력 월에서 FY/Q를 역산하지 않는다.

## 8. EBIT

`consolidated_net_income + income_tax_expense + interest_expense`.
입력 지표 수/이름, 동일 start/end/period type, USD, consolidated scope, 동일 원본 accession을 모두 검사한다.
누락은 NULL, 범위/기간/버전 불일치는 NULL 및 검토 상태로 차단한다.
기존 `financial_metrics.net_income`은 입력으로 재사용하지 않는다.

## 9. EBITDA

`ebit + depreciation_and_amortization`.
EBIT와 같은 정합성 검사를 적용한다. EBIT 내부 3개 입력과 두 누적 차감 원본까지 재귀 계산 근거를 보존한다.
EBITDAre/FFO/AFFO/NFFO로 표시하거나 계산하지 않는다.

## 10. Provenance

각 available row에 tag/taxonomy/form/accession/filed/start/end/unit/value, 계산 종류, source refs와 입력값을 저장한다.
직접/차감의 원본 날짜와 파생 값의 목표 기간 날짜를 구분한다.
출처 및 계산 입력 전체 SHA-256 fingerprint로 현재 값과 출처를 연결한다.
정정 값은 현재 raw 값을 갱신하되 과거 출처와 과거 metric_value는 append-only로 남긴다.
동일 재저장의 새 raw 값/출처 쓰기 0건. 출처 INSERT 도중 실패 시 raw 전체 batch도 rollback된다.
기존 sync 자체의 재무/provenance 갱신 정책은 재작성하지 않았고, 신규 raw 저장기는 해당 테이블을 쓰지 않는다.

## 11. 10종목 Coverage

대상 NVDA/GOOGL/AAPL/TSLA/MSFT/AMZN/O/JPM/ABBV/ABT 모두 같은 범용 경로로 로컬 검증했다.
ticker 조건은 production 추출/저장 코드에 없다.

중요: 실제 10종목 CompanyFacts 원문 snapshot은 로컬에 남아 있지 않았다. R2 O의 보존된 최소 진단값만 재구성 fixture로 사용했다.
추가 호출 금지를 지켜 재다운로드하지 않았다. 따라서 실제 10종목의 연간/분기/NULL 건수는 전부 `NOT VERIFIED`다.
아래는 실제 재무 coverage가 아닌, 10종목 이름을 사용한 합성 10년/40분기 자료의 구조 검증 결과다.
JPM 합성 자료에는 의도적으로 interest/D&A를 누락시켜 NULL 전파를 검사했다. 실제 JPM 공시 누락이라는 의미가 아니다.

| field | 합성 Annual 확보/대상 | 합성 Quarterly 확보/대상 | 합성 NULL Annual/Quarterly |
| --- | ---: | ---: | ---: |
| shares_outstanding | 100/100 | 400/400 | 0/0 |
| cash_and_cash_equivalents | 100/100 | 400/400 | 0/0 |
| total_assets | 100/100 | 400/400 | 0/0 |
| stockholders_equity | 100/100 | 400/400 | 0/0 |
| equity_including_nci | 100/100 | 400/400 | 0/0 |
| weighted_average_shares_basic | 100/100 | 400/400 | 0/0 |
| weighted_average_shares_diluted | 100/100 | 400/400 | 0/0 |
| interest_expense | 90/100 | 360/400 | 10/40 |
| consolidated_net_income | 100/100 | 400/400 | 0/0 |
| income_tax_expense | 100/100 | 400/400 | 0/0 |
| depreciation_and_amortization | 90/100 | 360/400 | 10/40 |
| ebit | 90/100 | 360/400 | 10/40 |
| ebitda | 90/100 | 360/400 | 10/40 |

R2 O 최소 자료에서는 FY2025 직접 11개 raw 및 derived 2개가 일치한다.
2026-06-30의 시점 값 5개와 2026 H1 YTD 합계 4개도 보존한다.
누적 weighted basic/diluted는 standalone이 아니므로 NULL. 이 최소 자료에는 standalone Q2 원본이 없으며, 실제 전체 응답에도 없다고 주장하지 않는다.

## 12. O 검증

| metric | FY2025 저장값 | R2 진단값 대조 |
| --- | ---: | --- |
| shares_outstanding | 933,975,000 shares | MATCH |
| cash_and_cash_equivalents | $434,842,000 | MATCH |
| total_assets | $72,795,612,000 | MATCH |
| stockholders_equity | $39,438,695,000 | MATCH |
| equity_including_nci | $40,123,968,000 | MATCH |
| weighted_average_shares_basic | 907,169,000 shares | MATCH |
| weighted_average_shares_diluted | 908,334,000 shares | MATCH |
| interest_expense | $1,134,879,000 | MATCH |
| consolidated_net_income | $1,069,783,000 | MATCH |
| income_tax_expense | $85,346,000 | MATCH |
| depreciation_and_amortization | $2,524,200,000 | MATCH |
| ebit | $2,290,008,000 | MATCH; R2 BQ도 같은 값 |
| ebitda | $4,814,208,000 | MATCH; R2 BQ도 같은 값 |

모회사 NetIncomeLoss $1,058,590,000은 기존 재무 정책에 남기며 EBIT 입력으로 사용하지 않는다.
BQ Common Equity $40,123,968,000을 parent equity로 잘못 저장하지 않는다.

## 13. Existing Numeric Regression

10종목 × (Annual 10 + Quarterly 40) = 합성 `financial_metrics` 500행.
flag OFF 기존 sync와 flag ON 새 sync를 동일 payload로 대조했다.
Revenue/Operating Income/Net Income/EPS/FCF/ROE/ROIC/Gross Margin/Operating Margin 및 기존 비율/기간 식별 필드 불변.
기존 provenance 의미 digest와 classification 전체 의미 digest도 불변.

전/후 numeric digest:
`40908668f054408a32f42446c6fea8ce00e0ca44b57fbea708f54d66dd35e168`.

이 500행은 합성 로컬 regression이며 운영 500행을 다운로드해 재검증한 것이 아니다.
운영 DB에는 접근하거나 쓰지 않았다.

## 14. O Specialized Regression

기존 repo 밖 cache의 40개 문서를 재사용해 메모리 DB에 기존 경로로 적재했다. 네트워크 재다운로드 없음.
R3 저장 전/후: 14 definitions / 950 values / 1344 provenance 유지.
전/후 semantic digest:
`4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5`.

기존 P3 expected 36, P3/P4/P5A/P5B/definition/modern/storage 검증도 유지한다.
이는 기존 공식 parser/cache로 재현한 로컬 회귀이지 이번 단계의 새로운 production DB 검증이 아니다.

## 15. Migration Test

Fresh 0001~0020: PASS.
Existing 0001~0019 → 0020: PASS.
기존 숫자/분류 및 기존 provenance sentinel 유지, FK 검사 PASS.
migration 누락 상태에서 활성화하면 기존 재무 쓰기 전 중단: PASS.

## 16. Test

기존 722 + 신규 54 = 총 776 PASS / 0 FAIL.
`npm run check`, `git diff --check`, `r3:audit`: PASS.
기존 specialized 기본/historical/inventory/full-historical/definition-review/modern/storage audit: PASS.
definition-review 명령은 cache 인자를 받지 않아 최초 인자 전달을 거부했으며 올바른 인수 없는 실행으로 재검증 PASS. 외부 호출은 없었다.

테스트는 point-in-time/기간 합계/기간 평균, 태그 fallback/priority, parent/NCI, DEI 실제 날짜,
EBIT/EBITDA, scope/period/unit/accession mismatch, missing NULL, negative/zero,
평균 YTD 차감 금지, 같은 공시 차감, provenance round-trip/append-only/idempotency/rollback,
손상 fact, 실제 없는 날짜, 비달력 FY/Q, 기존 sync 단일 SEC 요청과 API 반환 호환성을 포함한다.

실제 provider API 호출: SEC 0 / BQ 0 / FMP 0 / Massive 0.
단일 요청 테스트의 fetch는 로컬 mock Response이며 실제 SEC 네트워크 호출이 아니다.

## 17. 수정 파일

- `worker/migrations/0020_sec_standard_raw_metrics.sql`
- `worker/src/sec-standard-raw.js`
- `worker/src/sec-standard-raw-store.js`
- `worker/src/fmp-sync.js` — import 및 비활성 기본 flag의 raw 저장 연결만
- `tests/fixtures/sec-standard-raw-o-r2.json` — R2 최소 진단값, 원문 전체 아님
- `tests/helpers/sec-standard-raw-fixtures.js` — 재구성 및 합성 자료
- `tests/sec-standard-raw.test.js`
- `scripts/sec-standard-raw-audit.mjs`
- `package.json` — r3:check/r3:audit
- `docs/sec-standard-raw-phase-r3-report.md`

UI/public router/scheduler/production config/기존 migration/기존 parser expected 수정 없음.
원문 PDF/cache/스크린샷/credential/환경파일 추가 없음. 실제 secret 및 이메일 검사 PASS.
새 파일은 미추적, 기존 변경은 unstaged 상태로 남겼으며 commit/push는 하지 않는다.

## 18. Production 변경

Production migration / DB write / backfill / Worker deploy / Pages deploy / commit / push: 전부 NO.
Release Sync: NO. Production 관측이나 새 인증 요청도 수행하지 않았다.
R3 flag의 운영 활성화: NO.

## 19. 발견 문제 및 검증 한계

1. 실제 10종목 원문 snapshot 미보유로 실제 raw historical coverage 미검증. 합성 결과를 실제 결과로 승격하지 않는다.
2. 직접 ProfitLoss가 없는 회사의 consolidated NI/EBIT는 NULL로 남는다. parent NetIncomeLoss 대체로 false coverage를 만들지 않는다.
3. 같은 accession의 누적 차감 근거가 없는 분기 합계는 NULL. 공시 간 restatement 검토 없이 차감하지 않는다.
4. 표준 InterestExpense/D&A의 issuer별 공시 의미 및 향후 EBITDA 비교 정의는 실제 원문에서 계속 검증해야 한다.
5. 운영 Free CPU/추가 D1 저장 비용은 이번 로컬 단계에서 검증하지 않았다. bulk bind/hash/보존 창의 운영 규모 평가가 배포 전 필요하다.
6. legacy 재무 저장과 신규 raw 저장은 각각 별도 batch다. raw batch 실패는 raw 전체 rollback되지만 이미 완료된 legacy sync batch까지 되돌리지 않는다. 운영 승격 전 이 실패/재시도 정책을 검토해야 한다.
7. Total Debt/Net Debt/leverage/EV/EV-EBITDA는 계속 BLOCKED; 구현하지 않았다.
8. FMP 상태는 로컬 credential 미확보이며 서비스 자체의 실패 판정이 아니다.

## 20. 다음 단계

결과 검토 후 별도 R3 checkpoint 승인. 이번에는 commit하지 않는다.
이후 별도 승인된 기존 SEC sync의 payload 또는 외부 보존 snapshot으로 10종목 실제 coverage/공시 scope를 검증한다.
Production 적용 전 CPU/D1 저장 한도, 실패/재시도 경계와 migration/flag 활성화 순서를 검토한다.
시장가치·부채·EV와 새 public API/REIT UI는 별도 Phase다.

## 최종 YES/NO

| 확인 | 결과 |
| --- | --- |
| 1. SEC 기존 호출 payload 재사용 구조 | YES |
| 2. 추가 SEC API 호출 증가 없음 | YES |
| 3. point-in-time/period/average 구분 | YES |
| 4. actual shares/weighted averages 구분 | YES |
| 5. EBIT/EBITDA 입력 및 source provenance | YES |
| 6. EBITDAre와 혼동하지 않음 | YES |
| 7. Total Debt/EV 억지 구현 없음 | YES |
| 8. 기존 financial 숫자 불변 | YES — 로컬 500행 regression, production 쓰기 없음 |
| 9. O specialized 불변 | YES — 14/950/1344 로컬 재현 및 digest 일치 |
| 10. 다음 범용 재무/REIT 단계 준비 | YES — 로컬 저장 기반 준비; 실제 10종목 coverage/운영 승격은 아직 미승인 |
