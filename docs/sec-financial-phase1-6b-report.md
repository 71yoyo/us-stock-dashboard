# SEC 재무 Phase 1.6B · 나머지 5종목 운영 backfill 결과

작성일: 2026-09-30 · Asia/Seoul.
판정: A. 지정한 나머지 5종목 검증 완료. 전체 10종목 metadata/provenance 준비 완료.
Phase 1.6C 준비 가능. normal 복원은 아직 승인·실행하지 않았다.

## [1. 작업 전 상태]

운영 financial_metrics 전체 500행, 종목 10개. migration 0016까지 이미 적용된 상태였다.
Phase 1.6A 처리한 5종목은 연간 10/10·분기 40/40이고 provenance 총 2,548행이었다.
남은 5종목 각각 annual 10행/quarterly 40행, 새 metadata 세 필드 모두 populated 0,
provenance 0행, metadataVersion 미설정이었다.

읽기 전용으로 기존 키 및 8개 지표를 조회해 전체/종목별 deterministic SHA-256을 확보했다.
SQL 정렬: ticker, period_type, fiscal_period_end 오름차순.
JSON 필드 순서: ticker, period_type, fiscal_period_end, revenue, operating_income,
net_income, eps, free_cash_flow, roe, gross_margin, operating_margin.
metadata·캐시 시각·reported_date는 이 digest에서 제외했다.
baseline 조회의 rows_written은 모두 0이었다.

전체 작업 전 digest:
```text
5590e9f97020ef87c310fa964fafec9519ff9967b40cf00317917fbd84c0acaf
```
Phase 1.6A 지정 digest와 동일했다.

추가로 읽기 전용 Time Travel 복구 지점을 확인했다:
```text
00000950-00000000-000050f6-31106480b489bdf9286d0be955d5a94c
```
복구는 실행하지 않았다. 전체 DB 복원은 다른 정상 데이터도 되돌릴 수 있으므로 별도 승인과 손실 검토가 필요하다.

처리 직전 운영 설정을 inherit한 비공개 Cloudflare preview에서 manual을 확인했다.
공개 production Worker 신규 배포 없이 운영 D1에 연결한 공식 wrangler dev --remote 경로를 사용했다.

## [2. ABBV]

단일 재처리 1회 → 개별 D1 검증 완료 후 다음 종목 진행.
검증 요청 HTTP 200, SEC 상태 200.
Annual: 총 10행, fiscal_year 10, fiscal_period 10, period_start 10.
Quarterly: 총 40행, fiscal_year 40, fiscal_period 40, period_start 40.
provenance 총 536행.
기존 50행 × 8개 지표 400개 Before/After 비교: 변경 0건. 대상 digest 동일.
metadata NULL 기간: 없음. source_refs_json 파싱 오류: 0건.
최신 annual: FY2025, 종료 2025-12-31, 시작 2025-01-01.
최신 quarterly: Q2 FY2026, 종료 2026-06-30, 시작 2026-04-01.
최신 분기 값이 존재하는 주요 지표 7개 모두 출처 확인.
출처 누락 0건, NULL 값의 가짜 출처 또는 본표와 출처 값 불일치 0건.

| 지표 | 계산 유형 | 입력 참조 수 | SEC 근거 |
| --- | --- | --- | --- |
| eps | direct | 1 | 10-Q 0001551152-26-000026 · 2026-08-03 |
| free_cash_flow | derived | 4 | 10-Q 0001551152-26-000026 · 2026-08-03<br>10-Q 0001551152-26-000017 · 2026-05-08 |
| net_income | direct | 1 | 10-Q 0001551152-26-000026 · 2026-08-03 |
| operating_income | direct | 1 | 10-Q 0001551152-26-000026 · 2026-08-03 |
| operating_margin | derived | 2 | 10-Q 0001551152-26-000026 · 2026-08-03 |
| revenue | direct | 1 | 10-Q 0001551152-26-000026 · 2026-08-03 |
| roe | derived | 2 | 10-Q 0001551152-26-000026 · 2026-08-03 |

파생값은 각 입력의 SEC tag·공시·기간·단위·값을 source_refs_json에서 확인했다.


## [3. ABT]

단일 재처리 1회 → 개별 D1 검증 완료 후 다음 종목 진행.
검증 요청 HTTP 200, SEC 상태 200.
Annual: 총 10행, fiscal_year 10, fiscal_period 10, period_start 10.
Quarterly: 총 40행, fiscal_year 40, fiscal_period 40, period_start 40.
provenance 총 524행.
기존 50행 × 8개 지표 400개 Before/After 비교: 변경 0건. 대상 digest 동일.
metadata NULL 기간: 없음. source_refs_json 파싱 오류: 0건.
최신 annual: FY2025, 종료 2025-12-31, 시작 2025-01-01.
최신 quarterly: Q1 FY2026, 종료 2026-03-31, 시작 2026-01-01.
최신 분기 값이 존재하는 주요 지표 7개 모두 출처 확인.
출처 누락 0건, NULL 값의 가짜 출처 또는 본표와 출처 값 불일치 0건.

| 지표 | 계산 유형 | 입력 참조 수 | SEC 근거 |
| --- | --- | --- | --- |
| eps | direct | 1 | 10-Q 0001628280-26-028357 · 2026-04-29 |
| free_cash_flow | derived | 2 | 10-Q 0001628280-26-028357 · 2026-04-29 |
| net_income | direct | 1 | 10-Q 0001628280-26-028357 · 2026-04-29 |
| operating_income | direct | 1 | 10-Q 0001628280-26-028357 · 2026-04-29 |
| operating_margin | derived | 2 | 10-Q 0001628280-26-028357 · 2026-04-29 |
| revenue | direct | 1 | 10-Q 0001628280-26-028357 · 2026-04-29 |
| roe | derived | 2 | 10-Q 0001628280-26-028357 · 2026-04-29 |

파생값은 각 입력의 SEC tag·공시·기간·단위·값을 source_refs_json에서 확인했다.
최신 저장 분기는 2026-03-31 Q1 FY2026이다. 이번 작업은 기존 숫자 보존과 metadata 추가이며 더 최신 분기를 임의 생성하거나 selection 정책을 바꾸지 않았다.


## [4. AMZN]

단일 재처리 1회 → 개별 D1 검증 완료 후 다음 종목 진행.
검증 요청 HTTP 200, SEC 상태 200.
Annual: 총 10행, fiscal_year 10, fiscal_period 10, period_start 10.
Quarterly: 총 40행, fiscal_year 40, fiscal_period 40, period_start 40.
provenance 총 493행.
기존 50행 × 8개 지표 400개 Before/After 비교: 변경 0건. 대상 digest 동일.
metadata NULL 기간: 없음. source_refs_json 파싱 오류: 0건.
최신 annual: FY2025, 종료 2025-12-31, 시작 2025-01-01.
최신 quarterly: Q2 FY2026, 종료 2026-06-30, 시작 2026-04-01.
최신 분기 값이 존재하는 주요 지표 7개 모두 출처 확인.
출처 누락 0건, NULL 값의 가짜 출처 또는 본표와 출처 값 불일치 0건.

| 지표 | 계산 유형 | 입력 참조 수 | SEC 근거 |
| --- | --- | --- | --- |
| eps | direct | 1 | 10-Q 0001018724-26-000026 · 2026-07-31 |
| free_cash_flow | derived | 2 | 10-Q 0001018724-26-000026 · 2026-07-31 |
| net_income | direct | 1 | 10-Q 0001018724-26-000026 · 2026-07-31 |
| operating_income | direct | 1 | 10-Q 0001018724-26-000026 · 2026-07-31 |
| operating_margin | derived | 2 | 10-Q 0001018724-26-000026 · 2026-07-31 |
| revenue | direct | 1 | 10-Q 0001018724-26-000026 · 2026-07-31 |
| roe | derived | 2 | 10-Q 0001018724-26-000026 · 2026-07-31 |

파생값은 각 입력의 SEC tag·공시·기간·단위·값을 source_refs_json에서 확인했다.


## [5. GOOGL]

단일 재처리 1회 → 개별 D1 검증 완료 후 다음 종목 진행.
검증 요청 HTTP 200, SEC 상태 200.
Annual: 총 10행, fiscal_year 10, fiscal_period 10, period_start 10.
Quarterly: 총 40행, fiscal_year 40, fiscal_period 40, period_start 40.
provenance 총 490행.
기존 50행 × 8개 지표 400개 Before/After 비교: 변경 0건. 대상 digest 동일.
metadata NULL 기간: 없음. source_refs_json 파싱 오류: 0건.
최신 annual: FY2025, 종료 2025-12-31, 시작 2025-01-01.
최신 quarterly: Q2 FY2026, 종료 2026-06-30, 시작 2026-04-01.
최신 분기 값이 존재하는 주요 지표 7개 모두 출처 확인.
출처 누락 0건, NULL 값의 가짜 출처 또는 본표와 출처 값 불일치 0건.

| 지표 | 계산 유형 | 입력 참조 수 | SEC 근거 |
| --- | --- | --- | --- |
| eps | direct | 1 | 10-Q 0001652044-26-000071 · 2026-07-23 |
| free_cash_flow | derived | 4 | 10-Q 0001652044-26-000071 · 2026-07-23<br>10-Q 0001652044-26-000048 · 2026-04-30 |
| net_income | direct | 1 | 10-Q 0001652044-26-000071 · 2026-07-23 |
| operating_income | direct | 1 | 10-Q 0001652044-26-000071 · 2026-07-23 |
| operating_margin | derived | 2 | 10-Q 0001652044-26-000071 · 2026-07-23 |
| revenue | direct | 1 | 10-Q 0001652044-26-000071 · 2026-07-23 |
| roe | derived | 2 | 10-Q 0001652044-26-000071 · 2026-07-23 |

파생값은 각 입력의 SEC tag·공시·기간·단위·값을 source_refs_json에서 확인했다.


## [6. TSLA]

단일 재처리 1회 → 개별 D1 검증 완료 후 다음 종목 진행.
검증 요청 HTTP 200, SEC 상태 200.
Annual: 총 10행, fiscal_year 10, fiscal_period 10, period_start 10.
Quarterly: 총 40행, fiscal_year 40, fiscal_period 40, period_start 40.
provenance 총 632행.
기존 50행 × 8개 지표 400개 Before/After 비교: 변경 0건. 대상 digest 동일.
metadata NULL 기간: 없음. source_refs_json 파싱 오류: 0건.
최신 annual: FY2025, 종료 2025-12-31, 시작 2025-01-01.
최신 quarterly: Q2 FY2026, 종료 2026-06-30, 시작 2026-04-01.
최신 분기 값이 존재하는 주요 지표 8개 모두 출처 확인.
출처 누락 0건, NULL 값의 가짜 출처 또는 본표와 출처 값 불일치 0건.

| 지표 | 계산 유형 | 입력 참조 수 | SEC 근거 |
| --- | --- | --- | --- |
| eps | direct | 1 | 10-Q 0001628280-26-049270 · 2026-07-23 |
| free_cash_flow | derived | 4 | 10-Q 0001628280-26-049270 · 2026-07-23<br>10-Q 0001628280-26-026673 · 2026-04-23 |
| gross_margin | derived | 2 | 10-Q 0001628280-26-049270 · 2026-07-23 |
| net_income | direct | 1 | 10-Q 0001628280-26-049270 · 2026-07-23 |
| operating_income | direct | 1 | 10-Q 0001628280-26-049270 · 2026-07-23 |
| operating_margin | derived | 2 | 10-Q 0001628280-26-049270 · 2026-07-23 |
| revenue | direct | 1 | 10-Q 0001628280-26-049270 · 2026-07-23 |
| roe | derived | 2 | 10-Q 0001628280-26-049270 · 2026-07-23 |

파생값은 각 입력의 SEC tag·공시·기간·단위·값을 source_refs_json에서 확인했다.



## [7. 전체 10종목 Metadata Coverage]

아래 Annual/Quarterly는 fiscal_year populated/total이다.
fiscal_period와 period_start도 모든 행에서 동일한 coverage를 확인했다.
임의 채움 없이 기존 SEC metadata 판정 결과를 저장했다.

| Ticker | Annual | Quarterly | Provenance |
| --- | --- | --- | --- |
| NVDA | 10/10 | 40/40 | 618 |
| AAPL | 10/10 | 40/40 | 645 |
| MSFT | 10/10 | 40/40 | 604 |
| JPM | 10/10 | 40/40 | 390 |
| O | 10/10 | 40/40 | 291 |
| ABBV | 10/10 | 40/40 | 536 |
| ABT | 10/10 | 40/40 | 524 |
| AMZN | 10/10 | 40/40 | 493 |
| GOOGL | 10/10 | 40/40 | 490 |
| TSLA | 10/10 | 40/40 | 632 |

총 재무 500행, FY/Period/Start 각각 500/500.
metadataVersion은 10종목 모두 1.
출처 총 5,223행. 주요 8개 지표 외 내부 계산 입력 출처도 포함하므로 500×8과 같아야 하는 수는 아니다.
이전 Phase 1.6A 5종목의 provenance 행 수와 각 숫자 digest도 그대로다.

## [8. 전체 Numeric Regression]

작업 전:
```text
5590e9f97020ef87c310fa964fafec9519ff9967b40cf00317917fbd84c0acaf
```
작업 후:
```text
5590e9f97020ef87c310fa964fafec9519ff9967b40cf00317917fbd84c0acaf
```
Phase 1.6A digest와 작업 전·후 모두 동일.
전체 500행 × 8개 재무 지표 4,000개 값의 변경 0건.
각 대상 재처리 직후 본표 50행을 직접 비교하고 별도 읽기 전용 digest로 다시 검증했다.

| Ticker | 작업 전 SHA-256 | 작업 후 | 숫자 변경 |
| --- | --- | --- | --- |
| ABBV | 846e9b8737b22d9cf0bb08cec13f0cdf5507bf95c72067cba9cf5da5df3922af | 동일 | 0 |
| ABT | f85b8adf7faeee6e05cb7068688c3e0c0aa8c9f0bc5b75ef32687b797988e780 | 동일 | 0 |
| AMZN | 8ad03cdd3edd0584900baa3938346b2e093888a0447cd454e32a5cee89f75331 | 동일 | 0 |
| GOOGL | 64da415913c053c69e9019736b8b88c743afe405f12452e01009b3fa04420f03 | 동일 | 0 |
| TSLA | 5a68641c2a05857751dc9ab7451db807339591c79687350131b9046db507ddfb | 동일 | 0 |

기존 NULL 보존: ABBV/ABT/AMZN/GOOGL 최신 분기의 gross_margin NULL을 유지했다.
Q4 EPS 등 기존 NULL을 누적 차감 또는 다른 API로 보완하지 않았다.
기존 음수 FCF와 음수 ROE를 양수로 보정하지 않았다.
재무 계산·EPS·FCF·ROE·SEC selection 정책은 바꾸지 않았다.

## [9. Provenance Integrity]

| 검증 | 결과 |
| --- | --- |
| orphan | 0 |
| invalidJson | 0 |
| duplicateSources | 0 |
| duplicateFinancialRows | 0 |
| unexpectedFinancialTickers | 0 |
| unexpectedProvenanceTickers | 0 |
| emptyOrNonArrayRefs | 0 |
| fakeOrMismatchedMetrics | 0 |

orphan provenance 0, invalid source_refs_json 0.
본표 PK 중복 0, provenance 논리 키 중복 0.
예상 밖 ticker는 financial_metrics/provenance 양쪽 모두 0.
비배열·빈 source_refs_json 0, 주요 지표 NULL의 가짜 출처/값 불일치 0.
대상 5종목의 source_refs_json 전체를 JavaScript로 파싱해 배열과 참조 존재도 확인했다.
direct/derived 및 FCF 입력의 ytd_difference처럼 실제 존재한 유형만 확인했다.
최신 quarterly에는 없던 fy_minus_9m 유형을 억지로 만들지 않았다.

## [10. API Smoke Test]

공개 API: https://us-stock-dashboard-api.771yoyo.workers.dev/api/companies/{ticker}

| Ticker | HTTP | financials | Annual/Quarterly | metadata populated | 기존 필드 |
| --- | --- | --- | --- | --- | --- |
| NVDA | 200 | 50 | 10/40 | 50/50 | 유지 |
| ABBV | 200 | 50 | 10/40 | 50/50 | 유지 |
| ABT | 200 | 50 | 10/40 | 50/50 | 유지 |
| AMZN | 200 | 50 | 10/40 | 50/50 | 유지 |
| GOOGL | 200 | 50 | 10/40 | 50/50 | 유지 |
| TSLA | 200 | 50 | 10/40 | 50/50 | 유지 |

모든 재무 행에 기존 필드와 fiscalYear/fiscalPeriod/periodStart가 존재함을 확인했다.
회사 응답의 가격·변동률·일봉·Williams 신호·배당 요약·Massive 배당 빈도/종류 필드를 유지했다.
HTTP 5xx와 필드 누락은 없었다.
UI 파일을 바꾸지 않았다. 브라우저 PIN/관심목록/포트폴리오/JSON 백업 직접 조작은 미실행이고,
읽기 전용 API·단위 테스트를 브라우저 검증 성공으로 대신 표기하지 않는다.

## [11. Test 결과]

작업 전과 최종: npm test 총 114, PASS 114, FAIL 0.
npm run check PASS.
검증 helper 두 파일 별도 node --check PASS.
git diff --check PASS. Git CRLF 안내는 공백 오류가 아니다.

기존 111개를 유지하고 Phase 1.6B 접근 통제 테스트 3개를 추가했다:
- manual 설정이 없으면 DB/외부 요청 이전 차단
- 이전 5종목·전역 요청·사전 확인 경로 거부, manual 읽기 허용
- 승인된 5종목도 metadataVersion=1이면 재호출 금지

## [12. Production Write Summary]

재처리 종목: ABBV → ABT → AMZN → GOOGL → TSLA.
각 POST 정확히 1회. 각 처리 뒤 numeric/provenance 검증을 끝낸 후 다음 종목을 실행했다.
대상 financial_metrics 250행의 metadata 및 재처리 시각과 provenance 2,675행을 추가 저장했다.
대상 fundamental_jobs.details에 metadataVersion=1 및 coverage 요약을 반영했다.
기존 숫자 변경 0건. Phase 1.6A 5종목은 재처리하지 않았다.

migration: NO. 기존 migration 파일 수정·0017 생성 없음.
production Worker deploy: NO. Pages deploy·Git commit/push도 없음.
Secret/production vars 교체: NO.
UI·배당·가격 코드 변경: NO.
Business Quant/FMP 호출: NO.
global sync·all-symbol 쓰기 loop·scheduler 강제 실행: NO.
가격·배당의 기존 독립 Cron은 이번 작업으로 강제 호출하거나 멈추지 않았다.

이번 로컬 검증 도구 변경:
- scripts/sec-financial-rollout-worker.js: 기존 재처리 경로를 고정 허용 목록 factory로 재사용. Phase 1.6A 기본 허용 목록 유지.
- scripts/sec-financial-phase1-6b-worker.js: 이번 5종목만 허용, 실제 manual 모드 상속 확인, GET 사전 SEC 재조회 차단.
- scripts/sec-financial-phase1-6b.wrangler.jsonc: 운영 SEC Secret/manual 설정 상속과 D1 binding. production deploy용이 아니다.
- tests/sec-financial-phase1-6b.test.js: 안전장치 테스트 3개.
- 이 보고서.

원격 preview는 완료 후 Ctrl+C로 종료했다.
종료 코드 1은 의도한 개발 서버 중단이며 운영 장애가 아니다.
unsafe/inherit의 실험적 설정 경고는 검증 도구에만 해당하며 production 설정을 변경하지 않았다.

## [13. Rollout Mode]

SEC_FINANCIAL_ROLLOUT_MODE=manual 유지.
실제 production 값을 inherit한 preview에서 작업 전·후 모두 HTTP 200, rolloutMode=manual,
databaseWrite=false로 확인했다. 설정 읽기만 수행했다.

회사정보 profile과 SEC 재무의 공통 runFundamentalBatch 큐는 계속 paused다.
가격·Massive 일봉·독립 Business Quant 배당 파이프라인은 이 설정의 중단 대상이 아니다.
manual은 자동 만료가 없다. 이번 단계에서는 normal 복원·전체 scheduler 실행을 하지 않았다.
사용자가 Phase 1.6C를 별도 승인하면 정상 모드 복원과 scheduler 상태 검증을 진행한다.

## [14. Phase 1.6C 준비 여부]

A. 남은 5종목 정상 완료.
전체 10종목 metadata/provenance 준비 완료.
Phase 1.6C 정상 모드 복원 계획과 scheduler 검증을 시작할 기술적 준비가 되었다.
준비 완료는 복원 승인과 다르며 이번 작업에서 normal로 변경하지 않았다.

| 최종 확인 | YES / NO |
| --- | --- |
| 1. ABBV 성공 | YES |
| 2. ABT 성공 | YES |
| 3. AMZN 성공 | YES |
| 4. GOOGL 성공 | YES |
| 5. TSLA 성공 | YES |
| 6. 전체 10종목 metadata coverage 정상 | YES |
| 7. 기존 재무 숫자 변경 0건 | YES |
| 8. provenance integrity 정상 | YES |
| 9. 기존 API 정상 | YES |
| 10. Phase 1.6C normal 복원 준비 | YES · 별도 승인 후 실행 |
