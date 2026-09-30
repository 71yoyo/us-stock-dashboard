# SEC 재무 기간·출처 보완 Phase 1 보고서

검증일: 2026-09-30. 범위: 로컬 코드와 폐기 가능한 메모리 SQLite 테스트 DB만.
UI, 배당, 차트, 운영 D1, 운영 배포는 변경하지 않았다.

## [1. 작업 전 상태]

- `git status --short`: 변경 없음.
- 기존 마이그레이션: `0001_initial.sql`부터 `0015_retire_alpha_dividends.sql`까지 15개. 최신 번호는 `0015`.
- 기존 전체 테스트: 70개 통과, 실패 0개.
- 기존 `financial_metrics` 열: `ticker`, `period_type`, `fiscal_period_end`, `reported_date`, `currency`, `revenue`, `operating_income`, `net_income`, `eps`, `peg_ratio`, `pe_ratio`, `ps_ratio`, `free_cash_flow`, `roe`, `roic`, `gross_margin`, `operating_margin`, `source`, `source_updated_at`, `cached_at`.
- 기존 기본키: `(ticker, period_type, fiscal_period_end)`.
- `selectSecFacts()`는 `...entry`로 원본 속성을 메모리에 보존했다. `fy`, `fp`, `form`, `filed`, `accn`/`accession`, `frame`, `start`, `end`, `val`은 원본에 있을 때 읽거나 보존할 수 있지만 DB에서 추적할 수 없었다. `unit`은 개별 fact 내부가 아니라 `units`의 키이며 기존 선택 결과에서는 잃고 있었다.
- `latestSecValues()`의 직접값 우선, 최신 제출일, 태그 우선순위, 누적 차감 정책을 확인했다. `syncFinancialsFromSec()` 내부 `writePeriod()`의 금액 계산식, 기간 보관 한도, `reported_date` 선택도 확인했다.
- 실제 NVDA CompanyFacts 요청은 HTTP 403으로 실패했다. 실제 응답에 있는 모든 속성을 확인했다고 주장하지 않는다.

## [2. 생성한 Migration]

`worker/migrations/0016_sec_financial_metadata.sql`을 추가했다.
기존 0001~0015 파일은 수정하지 않았다. 기간 열 3개와 지표별 출처 테이블을 추가하며 기존 값의 변경·추정 채우기는 하지 않는다.

## [3. financial_metrics 변경]

| 추가 열 | 의미 |
| --- | --- |
| `fiscal_year` | SEC 근거로 확인한 회사 회계연도 정수. 확인 불가 시 NULL |
| `fiscal_period` | 회사 회계기간 FY/Q1/Q2/Q3/Q4. 확인 불가 시 NULL |
| `period_start` | 직접 원본 시작일 또는 누적 차감으로 확인한 개별 기간 시작일. 충돌·불명확 시 NULL |

기존 `period_type`, `fiscal_period_end`, `reported_date` 및 수치 열은 유지한다.

## [4. financial_metric_provenance 구조]

| 열 | 의미 |
| --- | --- |
| `ticker` | 종목 |
| `period_type` | annual/quarterly |
| `fiscal_period_end` | 부모 재무 행의 종료일 |
| `metric_name` | 지표 또는 내부 계산 입력 식별자 |
| `sec_tag` | 직접/차감 원본의 SEC 태그. 복합 계산은 NULL |
| `form` | 직접/차감 주 원본의 공시 서식. 복합 계산은 NULL |
| `accession_number` | 직접/차감 주 원본의 공시 번호. 복합 계산은 NULL |
| `filed_date` | 직접/차감 주 원본의 제출일 |
| `source_start` | 주 원본의 시작일. 차감 결과의 개별 시작일과 구분 |
| `source_end` | 주 원본의 종료일 |
| `unit` | USD, USD/shares, % 등 |
| `calculation_type` | direct/ytd_difference/fy_minus_9m/derived |
| `source_refs_json` | 사용한 원본 전체. 태그·서식·공시 번호·날짜·단위·원액·fy/fp/frame 보존 |
| `metric_value` | 최종 선택값 또는 내부 입력값 |
| `calculation_details_json` | 계산식·입력 지표·입력값·하위 계산 종류 |
| `updated_at` | 출처 저장 갱신 시각 |

기본키는 `(ticker, period_type, fiscal_period_end, metric_name)`이다.
부모 재무 행에 복합 외래키와 `ON DELETE CASCADE`를 둔다.
`idx_financial_metric_provenance_filing(ticker, accession_number)`으로 종목·공시별 조회를 지원한다.
한 행 전체가 단일 공시에서 왔다는 잘못된 표현을 하지 않는다.

## [5. Fiscal Year / Quarter 판정 방식]

- raw fact를 공시 번호별로 묶고, 공시의 일관된 `fy/fp/form`과 해당 공시의 최신 실제 기간을 연결한다.
- Annual: 10-K/10-K/A의 FY 원본으로 `fiscal_year`와 FY를 식별한다.
- Q1/Q2/Q3: 10-Q/10-Q/A의 회사 `fp`를 사용한다. 종료 월이나 달력 분기로 Q 번호를 계산하지 않는다.
- Q4: 확인된 FY의 종료일과 연결한다. 누적 차감으로 생성된 경우 FY−9M 원본도 보존한다.
- 최신 비교값의 `fy/fp`는 그 비교 대상이 아니라 제출 공시의 기간일 수 있다. 따라서 비교값의 최신 `fy`를 과거 기간에 그대로 복사하지 않는다.
- 선택한 핵심 지표의 시작일이 서로 다르면 `period_start`는 NULL이다.
- 과거 비교값만 남은 불완전 공시를 현재 기간으로 오인하지 않도록 제출일과 기간 종료일의 간격도 보수적으로 검사한다. 연간 180일, 분기 60일을 넘는 공시에서는 그 공시만으로 기간 식별을 확정하지 않는다. 늦은 수정 공시는 원 공시의 기간 근거가 있으면 그것을 사용한다. 이 기준은 날짜로 FY/Q를 생성하는 규칙이 아니며, 정상적인 지연 제출도 근거 부족으로 NULL이 될 수 있는 보수적 제한이다.
- 근거 누락·충돌은 NULL로 남기고 숫자 선택 정책은 유지한다.

## [6. YTD Difference 처리]

Q2=6M−Q1, Q3=9M−6M의 기존 차감 숫자는 유지한다.
`calculation_type=ytd_difference`와 `current_ytd`, `previous_ytd` 역할의 두 원본을 저장한다.
각 원본의 `tag`, `form`, `accession`, `filed`, `start`, `end`, `unit`, `value`, `fy`, `fp`, `frame`을 보존한다.
개별 분기 시작일은 기존 차감 로직이 선택한 이전 누적 종료일 다음 날이며, 원본 누적 시작일은 출처 JSON에 따로 남긴다.

## [7. Q4 처리]

기존 FY−9M 차감값을 변경하지 않는다.
10-K/FY 연간 원본과 9개월 원본이 확인되면 `calculation_type=fy_minus_9m`으로 기록한다.
회사 FY 종료 근거로 Q4를 식별하고, 개별 시작일은 확인한 9M 종료 다음 날을 사용한다.
근거가 없으면 임의의 10월 1일 같은 날짜를 만들지 않는다.

## [8. SEC Provenance 처리]

- `direct`: 선택한 원본 1개.
- `ytd_difference`: 차감에 사용한 누적 원본 2개.
- `fy_minus_9m`: FY와 9M 원본 2개.
- `derived`: 기존 FCF·Gross Margin·Operating Margin·ROE 계산식 및 모든 입력 원본.

Revenue, Operating Income, Net Income, EPS뿐 아니라 Gross Profit, Equity, Operating Cash Flow, CapEx와 은행 재무 대체식의 입력도 출처 테이블에 저장한다. `financial_metrics`에 원액 열을 대량 추가하지 않았다.
복합 계산의 최상위 단일 태그·서식·공시 번호는 NULL이며 입력별 원본이 JSON에 있다.
부모 숫자와 지표 출처를 같은 기간 유형의 `DB.batch`에서 원자적으로 갱신한다. 연간과 분기 저장은 기존처럼 별도 배치다.

## [9. 기존 숫자 선택 정책]

숫자 선택 정책은 변경하지 않았다. 직접값 우선, 같은 종류에서는 최신 `filed`, 같은 제출일에서는 태그 우선순위를 유지했다.
오래된 직접값이 더 최신 수정 공시의 차감값보다 우선할 수 있는 위험도 그대로 남는다. 이를 명시하는 테스트를 추가했고 임의로 정책을 바꾸지 않았다.
`reported_date`의 기존 선택 방식도 유지했다. 정확한 지표별 제출일은 새 테이블에서 확인한다.

## [10. EPS 처리]

기존 선택·계산 정책을 유지했다. EPS 누적 차감으로 Q4를 만들지 않는다.
직접 분기 EPS가 없으면 Q4 EPS는 계속 NULL이다. 원본 태그·단위·공시 출처는 저장한다.
분할 보정 문제는 해결하지 않았다.

## [11. 기존 데이터 Backfill]

마이그레이션만 적용한 기존 행의 새 열은 NULL이고 출처 행은 비어 있다.
종료일로 FY/Q를 역산하는 SQL은 없다.
향후 정상 SEC 수집에서 기존 공시 번호가 같아도 `metadataVersion=1`이 없는 작업은 한 번 재처리하도록 했다. 실제 실행·배포는 하지 않았다.
인공 원본으로 재처리와 반복 실행을 검증했다.

[BLOCKER] 실제 NVDA SEC CompanyFacts HTTP 403으로 실제 원본 재처리는 보류했다. 접근 가능한 공식 원본 JSON 또는 정상적인 공식 원본 접근 환경이 필요하다. 추정값을 대신 저장하지 않았다.

## [12. NVDA 검증 결과]

실제 운영 회사 API를 읽기 전용으로 조회한 숫자 표본 4개를 기존 스키마의 메모리 테스트 DB에 복사한 뒤 새 마이그레이션을 적용했다.

실제 저장값 표본 `2026-07-26`의 마이그레이션 후 결과:

- `fiscal_year`: NULL
- `fiscal_period`: NULL
- `period_start`: NULL

운영 DB는 변경하지 않았다. 실제 SEC 원본이 없으므로 FY2017~FY2026 전 이력과 실제 Q2 FY2027 적재를 검증 완료했다고 주장하지 않는다.
별도의 인공 fact에서 `fy=2027`, `fp=Q2`, `end=2026-07-26`을 사용한 판정·전체 저장 테스트는 Q2 FY2027로 통과했다. 이것은 알고리즘 검증이며 실제 NVDA 원본 검증이 아니다.

## [13. 기존 숫자 Regression 결과]

실제 저장값 표본의 연간 2개·분기 2개, 지표 8개 모두 마이그레이션 전후 동일했다. NULL도 그대로 보존됐다.
아래는 분기 `2026-07-26`의 이전 값이며 이후 값도 동일하다.

| 지표 | 이전 값 = 이후 값 |
| --- | ---: |
| Revenue | 96,221,000,000 |
| Operating Income | 63,734,000,000 |
| Net Income | 59,688,000,000 |
| EPS | 2.46 |
| FCF | 21,400,000,000 |
| ROE | 26.06645005764595% |
| Gross Margin | 74.97531723844068% |
| Operating Margin | 66.23710000935347% |

나머지 표본 종료일은 Annual 2025-01-26, Annual 2026-01-25, Quarterly 2026-01-25다.
인공 원본의 전체 SEC 저장 경로에서도 8개 지표의 기존 계산 기대값과 `reported_date`가 유지됐다.
실제 NVDA 원본 전체 재처리 전후의 숫자 비교는 HTTP 403으로 미검증이다. 마이그레이션 보존 검증과 실제 원본 재처리 검증을 혼동하지 않는다.

## [14. Migration 검증]

- Fresh DB: PASS. 메모리 SQLite에 0001~0016 순서 적용.
- Existing DB: PASS. 0001~0015 적용 및 기존 NVDA 표본 삽입 후 0016만 적용.
- 기본키·색인·외래키 일관성: PASS.
- 기존 금액과 NULL 보존: PASS.

## [15. 전체 Test 결과]

- 전체 `npm test`: 92개 중 PASS 92, FAIL 0, 건너뜀 0.
- 기존 테스트: 70개 모두 통과. 기존 테스트 파일·기대값 수정 없음.
- 신규 `tests/sec-financial-metadata.test.js`: 22개 모두 통과.
- 실패 테스트명: 없음.
- `npm run check`: 통과.
- `git diff --check`: 통과. Git의 LF/CRLF 안내는 파일 손상·테스트 실패가 아니다.

신규 테스트는 Annual, 직접 Q1/Q2, Q2/Q3 차감, Q4, 수정 공시 정책, EPS, 달력과 다른 회사 회계분기, 비교기간 오인 방지, NULL·충돌, 전체 저장, 중복 방지, 일회 재처리, 403 보존, 출처 쓰기 실패 롤백, 제거된 출처 정리, API 호환성, 두 경로 마이그레이션을 포함한다.

## [16. 수정 파일]

- `worker/migrations/0016_sec_financial_metadata.sql`: 새 기간 열과 출처 테이블.
- `worker/src/sec-financial-metadata.js`: 기간 식별·원본 추적·출처 저장 공통 처리.
- `worker/src/fmp-sync.js`: SEC 선택 결과에 단위·출처를 보존하고 기존 금액과 함께 저장.
- `worker/src/fundamental-sync.js`: 기존 공시도 새 출처 저장 버전으로 한 번 재처리.
- `worker/src/index.js`: 기존 회사 API에 기간 필드 3개만 추가.
- `tests/sec-financial-metadata.test.js`: 신규 검증 22개.
- `package.json`: 새 모듈을 기존 구문 검사에 포함. 의존성 변경 없음.
- `docs/sec-financial-phase1-report.md`: 검증 결과와 미확인 범위 기록.

## [17. Production 변경 여부]

- production DB write: NO.
- production migration 적용: NO.
- deployment: NO.
- 허용된 운영 작업은 기존 회사 API의 읽기 전용 표본 조회뿐이다.

향후 별도 승인 후 배포할 경우 DB에 새 마이그레이션을 먼저 적용해야 한다. 새 Worker는 새 열을 조회하므로 구형 스키마에 새 코드만 배포하면 호환되지 않는다.

## [18. 남은 문제]

- 실제 SEC 원본 접근 HTTP 403과 NVDA 전체 재처리.
- EPS split adjustment는 미변경.
- Q4 EPS 결측 정책은 미변경.
- 오래된 direct와 최신 amended-derived 사이 선택 위험은 미변경.
- FCF=영업현금흐름−절대값 CapEx 정의는 미변경.
- ROE=순이익/기말 자본 정의는 미변경. 평균 자본·분기 연율화는 구현하지 않았다.
- PER/P/S/PEG, ROIC, Net Margin은 구현하지 않았다.
- 기간 근거가 없거나 보수적 제출 지연 기준을 초과한 행은 NULL이다. 인공 검증을 전체 실제 기업의 완전한 기간 커버리지로 해석하면 안 된다.

## [19. 다음 Phase 준비 상태]

1. 정확한 fiscal year를 저장할 수 있는가? YES — SEC 근거가 있을 때.
2. 정확한 FY/Q1/Q2/Q3/Q4를 저장할 수 있는가? YES — SEC 근거가 있을 때, 불명확한 경우 NULL.
3. metric별 SEC source를 추적할 수 있는가? YES.
4. YTD difference의 원본 source를 추적할 수 있는가? YES.
5. Q4 derived value의 원본 source를 추적할 수 있는가? YES.
6. 기존 financial API 호환성이 유지되는가? YES — 새 마이그레이션 적용 환경에서 검증.
7. 기존 UI가 그대로 유지되는가? YES — UI 파일 변경 없음, 기존 화면 관련 테스트 통과.
8. Revenue+Net Income+Net Margin 차트 개발을 시작할 데이터 기반이 준비됐는가? NO — 저장 구조와 테스트 기반은 준비됐지만 실제 NVDA 원본 재처리·기간 커버리지 검증이 남았다. 차트와 Net Margin은 이번에 구현하지 않았다.
