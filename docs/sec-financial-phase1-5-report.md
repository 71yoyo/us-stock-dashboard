# SEC 재무 기간·출처 보완 Phase 1.5 실제 데이터 검증 보고서

검증일: 2026-09-30. 실행 환경: 로컬 Windows PC, Node.js v24.19.0.
수집 자료는 실제 공식 API 응답이다. 비교·재처리는 메모리 SQLite에서만 수행했으며 운영 DB, 화면, 배당, 계산 정책은 변경하지 않았다.

## [1. 시작 상태]

시작 시 작업 트리는 이전 Phase 1의 미커밋 변경을 포함했다. 아래 변경을 그대로 보존했다.

```text
 M package.json
 M worker/src/fmp-sync.js
 M worker/src/fundamental-sync.js
 M worker/src/index.js
?? docs/sec-financial-phase1-report.md
?? tests/sec-financial-metadata.test.js
?? worker/migrations/0016_sec_financial_metadata.sql
?? worker/src/sec-financial-metadata.js
```

기존 테스트 92개 PASS, FAIL 0개. 시작 시 npm run check 통과.
마이그레이션 0001~0016 총 16개. 최신은 0016_sec_financial_metadata.sql이며 0017은 만들지 않았다.

| 환경변수 | 시작 | 이번 검증 완료 시 |
| --- | --- | --- |
| SEC_USER_AGENT | missing | configured · 사용자 제공 연락 이메일 설정 |
| MARKET_DATA_API_KEY | missing | missing |
| FMP_API_KEY | missing | missing |
| BUSINESS_QUANT_API_KEY | configured | configured |

실제 키·토큰 값은 보고서와 로그에 출력하지 않았다. 사용자에게 FMP 로컬 키 설정을 요청했으나 검증 시점에는 없었다. 운영 Secret을 추출하거나 임의 발급하지 않았다.

## [2. SEC 403 원인]

기존 기본 User-Agent는 앱 이름과 GitHub URL뿐이었고 실제 연락 이메일이 없었다.
같은 로컬 PC에서 기존 기본값을 사용한 NVDA CompanyFacts 요청은 HTTP 403, text/html, AkamaiGHost를 반환했다. 차단 제목은 “Your Request Originates from an Undeclared Automated Tool”이었다.
사용자 제공 이메일을 포함한 SEC_USER_AGENT로 바꾼 뒤 동일한 공식 endpoint는 HTTP 200 JSON을 반환했다.

따라서 이 로컬 재현에서는 자동 접근 주체·연락처 선언 부족이 유력한 원인이며, 정상 선언 후 접근 복구를 실제 확인했다.
SEC 내부 차단 알고리즘이나 운영 Cloudflare egress의 상태까지 확정한 것은 아니다. CORS 오류나 SEC API 키 문제로 판정하지 않는다.

## [3. SEC 접근 수정]

worker/.dev.vars에 SEC_USER_AGENT를 설정했다. 형식은 앱 이름 + 사용자 제공 실제 이메일이다. 이 파일은 Git에서 제외되는 것을 확인했고 기존 Secret은 보존했다.

현재 SEC 요청 함수가 이미 이 환경변수를 우선 사용하므로 운영 request layer 코드 수정은 필요하지 않았다.
새 scripts/sec-financial-audit.mjs는 공식 원본 1회 조회, 안전한 진단, 메모리 재처리 및 보고서용 비교만 담당한다.
검증 도구는 20초 timeout, redirect:error, 실패 시 자동 재시도 없음으로 동작한다. 운영 재시도·metadata·수치 선택 정책은 수정하지 않았다.

## [4. SEC 공식 접근 검증]

공식 지침은 선언된 User-Agent, 절제된 자동 접근, 최대 초당 10회 요청을 요구한다. [SEC 접근 지침](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)

| 항목 | Current | SEC Guidance | Difference | Action Needed |
| --- | --- | --- | --- | --- |
| URL / method | GET https://data.sec.gov/api/xbrl/companyfacts/CIK0001045810.json | 10자리 CIK CompanyFacts JSON | 없음 | 기존 endpoint 유지 |
| User-Agent | 기본값에 연락 이메일 없음 → 로컬 설정 후 실제 이메일 포함 | 앱/수집 주체와 연락 이메일 선언 | 기본값은 불충분 | 이번 로컬 설정 완료; 운영 환경은 별도 확인 필요 |
| Accept | application/json | JSON API | 충돌 없음 | 없음 |
| Host | Node가 data.sec.gov를 전송 | 문서 예시 Host는 www.sec.gov | 요청 대상 호스트가 다를 뿐 | data.sec.gov에 www.sec.gov를 강제하지 않음 |
| compression | Node 실제 전송 br, gzip, deflate | 예시는 gzip, deflate | br 추가 광고 | 동일 헤더로 200 확인; 변경 불필요 |
| redirect | 운영 fetch 기본 follow; 검증 도구 error | API 공식 URL 직접 사용 | 공식 문서에 이 timeout/redirect 값 강제 없음 | 이번 실제 응답 redirect 없음 |
| timeout | SEC 운영·검증 모두 20초 | 특정 timeout 수치 지침 확인 안 됨 | 비교할 필수 수치 없음 | 유지 |
| retry | 운영 즉시 반복 없음, 403은 예약 시 6시간 후; 검증은 재시도 없음 | 부하 제한·절제된 접근 | 운영 전체 초당 제한은 중앙 보장되지 않음 | 다음 운영 준비에서 호출 합산 확인 |
| 요청 간격 | 검증 직렬·요청 사이 간격; 운영 캐시·예약 순환 | 최대 10회/초 | 여러 실행자 전체를 묶는 제한기는 없음 | 이번 검증은 한도 아래; 중앙 제한은 추가하지 않음 |
| 실행 환경 | 로컬 Node fetch 실제 wire header 확인 | 자동 접근도 공정 사용 준수 | Cloudflare fetch 실제 wire header 미관측 | 로컬 성공을 운영 성공으로 단정하지 않음 |
| CORS | 서버에서 요청 | data.sec.gov는 CORS 미지원 | 브라우저 직접 요청과 다른 경로 | 서버 경로 유지 |

실제 wire header에서 Host, Accept, Accept-Encoding, connection:keep-alive 및 User-Agent 선언 여부를 확인했다. 민감 값은 출력하지 않았다.
CompanyFacts는 인증이나 API 키가 필요 없는 공식 API다. [SEC API 문서](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)

전체 진단 호출: SEC 8회(기존 기본값 403 1회, 정상 NVDA 조회 3회, 추가 종목 4회), BusinessQuant 7회(인증 포함 200 6회, 진단 입력 실수로 키 없는 요청 401 1회), 운영 공개 API 읽기 전용 2회, FMP 0회.
403을 반복 재시도하거나 proxy, IP rotation, mirror, 우회 수단을 사용하지 않았다. 성공 응답 재조회는 단계별 파서·출처 검증 중 발생했으며 더 이상 호출하지 않는다.

## [5. 실제 NVDA CompanyFacts 확보]

YES. 공식 CIK 0001045810 endpoint에서 HTTP 200 JSON을 확보했다. 원본 크기는 약 4.09 MB였다.

US-GAAP fact 표본 전체 27,114건의 실제 구조:

| 항목 | 존재 건수 |
| --- | --- |
| fy | 27,109 |
| fp | 27,109 |
| form | 27,114 |
| filed | 27,114 |
| accn | 27,114 |
| frame | 11,878 |
| start | 15,552 |
| end | 27,114 |
| val | 27,114 |
| unit | 27,114 · units 키에서 보존 |

unit은 개별 fact 내부 속성이 아니라 units의 키다. 실제 단위에는 USD, USD/shares, shares, pure, instrument, segment가 있었다.
frame은 선택적으로 존재하고, 시점값에는 start가 없는 것이 정상이다. 모든 원본 fact에 fy/fp가 존재한다고 가정하지 않았다. 실제 구조 때문에 schema를 재변경할 필요는 없었다.

## [6. 실제 NVDA 재처리]

YES. DatabaseSync(':memory:')에 기존 0001~0016을 적용한 새 검증 DB를 만들고 실제 syncFinancialsFromSec 경로로 처리했다.
SEC 원본은 요청 범위의 secFacts 캐시에 주입해 pipeline 내부 중복 외부 요청을 방지했다.
DB는 finally에서 닫아 폐기했다. 로컬 기존 SQLite와 운영 D1에는 쓰지 않았다.
BusinessQuant/FMP 비교 자료는 이 메모리 SEC DB에도 저장하지 않았다.

## [7. NVDA Annual Metadata Coverage]

총 rows 10; fiscal_year 10/10; fiscal_period 10/10; period_start 10/10.
FY2017~FY2026 모두 FY와 실제 시작일을 식별했다. 기간 metadata NULL은 0건이다.
아래는 실제 재처리 수치다. 금액은 USD, EPS는 USD/shares, ROE·마진은 %이다.

| FY | 기간 | 시작 | 종료 | reported_date | revenue | operating_income | net_income | eps | free_cash_flow | roe % | gross_margin % | operating_margin % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026 | FY | 2025-01-27 | 2026-01-25 | 2026-02-25 | 215938000000 | 130387000000 | 120067000000 | 4.9 | 96676000000 | 76.33333969089534 | 71.06808435754708 | 60.38168363141272 |
| 2025 | FY | 2024-01-29 | 2025-01-26 | 2026-02-25 | 130497000000 | 81453000000 | 72880000000 | 2.94 | 60853000000 | 91.87288060811576 | 74.98869705816992 | 62.417526839697466 |
| 2024 | FY | 2023-01-30 | 2024-01-28 | 2026-02-25 | 60922000000 | 32972000000 | 29760000000 | 1.19 | 27021000000 | 69.24472986178975 | 72.71757329043696 | 54.121663766783755 |
| 2023 | FY | 2022-01-31 | 2023-01-29 | 2025-02-26 | 26974000000 | 4224000000 | 4368000000 | 0.17 | 3808000000 | 19.763811592235644 | 56.928894490991325 | 15.65952398606065 |
| 2022 | FY | 2021-02-01 | 2022-01-30 | 2024-02-21 | 26914000000 | 10041000000 | 9752000000 | 3.85 | 8132000000 | 36.64512250112731 | 64.92903321691314 | 37.307720888756776 |
| 2021 | FY | 2020-01-27 | 2021-01-31 | 2023-02-24 | 16675000000 | 4532000000 | 4332000000 | 1.73 | 미확보 | 25.64375776949032 | 62.3448275862069 | 27.178410794602698 |
| 2020 | FY | 2019-01-28 | 2020-01-26 | 2022-03-18 | 10918000000 | 2846000000 | 2796000000 | 1.13 | 미확보 | 22.910521140609635 | 61.9893753434695 | 26.06704524638212 |
| 2019 | FY | 2018-01-29 | 2019-01-27 | 2021-02-26 | 11716000000 | 3804000000 | 4141000000 | 6.63 | 미확보 | 44.326696638835365 | 61.206896551724135 | 32.46841925571868 |
| 2018 | FY | 2017-01-30 | 2018-01-28 | 2020-02-20 | 9714000000 | 3210000000 | 3047000000 | 4.82 | 미확보 | 40.78436621603534 | 59.934115709285564 | 33.045089561457694 |
| 2017 | FY | 2016-02-01 | 2017-01-29 | 2019-02-21 | 6910000000 | 1934000000 | 1666000000 | 2.57 | 미확보 | 28.913571676501213 | 58.798842257597684 | 27.988422575976845 |

전체 재처리에서 SEC 출처 618건이 생성됐다. 최신 8개 지표의 지표별 원본 검증은 [10]에 있다.
기존 선택 정책에 따라 reported_date는 과거 기간의 최초 제출일이 아니라 선택된 비교값을 포함한 후속 공시일일 수 있다. 이 값을 이번에 바꾸지 않았다.
FY2017~FY2021 FCF는 기존 후보 태그·선택 범위에서 미확보이며 기간 metadata 실패와 구분한다.

## [8. NVDA Quarterly Metadata Coverage]

총 rows 40; fiscal_year 40/40; fiscal_period 40/40; period_start 40/40.
기간 metadata NULL은 0건이다. 최근 12개 분기의 실제 값:

| FY | Q | 시작 | 종료 | revenue | net_income | eps |
| --- | --- | --- | --- | --- | --- | --- |
| 2027 | Q2 | 2026-04-27 | 2026-07-26 | 96221000000 | 59688000000 | 2.46 |
| 2027 | Q1 | 2026-01-26 | 2026-04-26 | 81615000000 | 58321000000 | 2.39 |
| 2026 | Q4 | 2025-10-27 | 2026-01-25 | 68127000000 | 42960000000 | 미확보 |
| 2026 | Q3 | 2025-07-28 | 2025-10-26 | 57006000000 | 31910000000 | 1.3 |
| 2026 | Q2 | 2025-04-28 | 2025-07-27 | 46743000000 | 26422000000 | 1.08 |
| 2026 | Q1 | 2025-01-27 | 2025-04-27 | 44062000000 | 18775000000 | 0.76 |
| 2025 | Q4 | 2024-10-28 | 2025-01-26 | 39331000000 | 22091000000 | 미확보 |
| 2025 | Q3 | 2024-07-29 | 2024-10-27 | 35082000000 | 19309000000 | 0.78 |
| 2025 | Q2 | 2024-04-29 | 2024-07-28 | 30040000000 | 16599000000 | 0.67 |
| 2025 | Q1 | 2024-01-29 | 2024-04-28 | 26044000000 | 14881000000 | 0.6 |
| 2024 | Q4 | 2023-10-30 | 2024-01-28 | 22103000000 | 12285000000 | 미확보 |
| 2024 | Q3 | 2023-07-31 | 2023-10-29 | 18120000000 | 9243000000 | 0.37 |

Q4 EPS 3개는 기존 정책상 미확보다. 기간 정보와 EPS 수치 결측을 구분한다.
출처 생성은 동일한 실제 SEC 재처리 경로를 사용했고 전체 출처 618건 중 direct 340, ytd_difference 38, fy_minus_9m 53, derived 187건이었다.

## [9. 2026-07-26 검증]

실제 SEC 원본 EarningsPerShareDiluted fact:

| 속성 | 값 |
| --- | --- |
| fy | 2027 |
| fp | Q2 |
| form | 10-Q |
| accn | 0001045810-26-000075 |
| filed | 2026-08-26 |
| start | 2026-04-27 |
| end | 2026-07-26 |
| val | 2.46 |
| units 키 | USD/shares |
| frame | CY2026Q2 |

재처리 결과 fiscal_year=2027, fiscal_period=Q2, period_start=2026-04-27, fiscal_period_end=2026-07-26.
답을 하드코딩하거나 7월을 달력 Q3로 변환하지 않았다.
frame은 달력 기간이므로 회사 FY/FQ와 동일하게 취급하지 않는다. [SEC frame 설명](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)

## [10. Provenance 실제 검증]

최신 분기 2026-07-26의 요청된 8개 지표 모두 출처 행이 있었다.

| 지표 | calculation_type | sec_tag | unit | source_refs 건수 | 값 |
| --- | --- | --- | --- | --- | --- |
| eps | direct | EarningsPerShareDiluted | USD/shares | 1 | 2.46 |
| free_cash_flow | derived | NULL · 복수 입력 | USD | 4 | 21400000000 |
| gross_margin | derived | NULL · 복수 입력 | % | 2 | 74.97531723844068 |
| net_income | direct | NetIncomeLoss | USD | 1 | 59688000000 |
| operating_income | direct | OperatingIncomeLoss | USD | 1 | 63734000000 |
| operating_margin | derived | NULL · 복수 입력 | % | 2 | 66.23710000935347 |
| revenue | direct | Revenues | USD | 1 | 96221000000 |
| roe | derived | NULL · 복수 입력 | % | 2 | 26.06645005764595 |

direct 행의 form/accession/filed/source_start/source_end는 원본과 일치했다.
derived 행은 여러 입력을 사용하므로 최상위 단일 sec_tag/form/accession/date는 NULL이다. 대신 각 입력의 실제 원본이 source_refs_json에 보존되며 이는 결측 오류가 아니다.
JSON 전체는 출력하지 않고 아래 표로 요약했다.

| 대상 지표 | SEC tag | form | accession | filed | source_start | source_end | unit | 원본값 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eps | EarningsPerShareDiluted | 10-Q | 0001045810-26-000075 | 2026-08-26 | 2026-04-27 | 2026-07-26 | USD/shares | 2.46 |
| free_cash_flow | NetCashProvidedByUsedInOperatingActivities | 10-Q | 0001045810-26-000075 | 2026-08-26 | 2026-01-26 | 2026-07-26 | USD | 74421000000 |
| free_cash_flow | NetCashProvidedByUsedInOperatingActivities | 10-Q | 0001045810-26-000052 | 2026-05-20 | 2026-01-26 | 2026-04-26 | USD | 50344000000 |
| free_cash_flow | PaymentsToAcquireProductiveAssets | 10-Q | 0001045810-26-000075 | 2026-08-26 | 2026-01-26 | 2026-07-26 | USD | 4434000000 |
| free_cash_flow | PaymentsToAcquireProductiveAssets | 10-Q | 0001045810-26-000052 | 2026-05-20 | 2026-01-26 | 2026-04-26 | USD | 1757000000 |
| gross_margin | GrossProfit | 10-Q | 0001045810-26-000075 | 2026-08-26 | 2026-04-27 | 2026-07-26 | USD | 72142000000 |
| gross_margin | Revenues | 10-Q | 0001045810-26-000075 | 2026-08-26 | 2026-04-27 | 2026-07-26 | USD | 96221000000 |
| net_income | NetIncomeLoss | 10-Q | 0001045810-26-000075 | 2026-08-26 | 2026-04-27 | 2026-07-26 | USD | 59688000000 |
| operating_income | OperatingIncomeLoss | 10-Q | 0001045810-26-000075 | 2026-08-26 | 2026-04-27 | 2026-07-26 | USD | 63734000000 |
| operating_margin | OperatingIncomeLoss | 10-Q | 0001045810-26-000075 | 2026-08-26 | 2026-04-27 | 2026-07-26 | USD | 63734000000 |
| operating_margin | Revenues | 10-Q | 0001045810-26-000075 | 2026-08-26 | 2026-04-27 | 2026-07-26 | USD | 96221000000 |
| revenue | Revenues | 10-Q | 0001045810-26-000075 | 2026-08-26 | 2026-04-27 | 2026-07-26 | USD | 96221000000 |
| roe | NetIncomeLoss | 10-Q | 0001045810-26-000075 | 2026-08-26 | 2026-04-27 | 2026-07-26 | USD | 59688000000 |
| roe | StockholdersEquity | 10-Q | 0001045810-26-000075 | 2026-08-26 | NULL · 시점값 | 2026-07-26 | USD | 228984000000 |

대표 계산 사례:

| calculation_type | 최종 지표/기간 | 최종값 | 실제 입력 및 계산 |
| --- | --- | --- | --- |
| direct | eps / 2026-07-26 | 2.46 | EarningsPerShareDiluted 원본 2.46 |
| ytd_difference | capital_expenditure / 2026-07-26 | 2677000000 | 6개월 4434000000 − 1분기 1757000000 |
| fy_minus_9m | capital_expenditure / 2026-01-25 | 1284000000 | 연간 6042000000 − 9개월 4758000000 |
| derived | free_cash_flow / 2026-07-26 | 21400000000 | OCF 24077000000 − abs(CapEx 2677000000) |

ytd_difference 입력은 위 표의 PaymentsToAcquireProductiveAssets 10-Q 두 건이다.
fy_minus_9m 입력은 아래 두 원본이다.

| tag | form | accession | filed | start | end | val | unit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PaymentsToAcquireProductiveAssets | 10-K | 0001045810-26-000021 | 2026-02-25 | 2025-01-27 | 2026-01-25 | 6042000000 | USD |
| PaymentsToAcquireProductiveAssets | 10-Q | 0001045810-25-000230 | 2025-11-19 | 2025-01-27 | 2025-10-26 | 4758000000 | USD |

실제 SEC source만 출처 테이블에 사용했다. BusinessQuant/FMP를 SEC 출처로 복사하지 않았다.

## [11. Numeric Regression]

운영 공개 company API의 기존 저장값을 읽기 전용으로 조회하여 최신 Annual 2개 + Quarterly 4개 × 8개 지표 = 48칸을 비교했다.
47개는 수치가 정확히 같았다. 나머지 Q4 EPS 1개는 양쪽 모두 NULL로 상태가 같았다. 변경된 숫자는 0개다.
이는 표본 48칸의 검증 결과이며 전체 종목·모든 과거 저장값까지 검사했다고 주장하지 않는다.

| 기간 | 지표 | 운영 저장값 | 재처리값 | 차이 | 차이 % | 판정 |
| --- | --- | --- | --- | --- | --- | --- |
| annual 2026-01-25 | revenue | 215938000000 | 215938000000 | 0 | 0% | MATCH |
| annual 2026-01-25 | operating_income | 130387000000 | 130387000000 | 0 | 0% | MATCH |
| annual 2026-01-25 | net_income | 120067000000 | 120067000000 | 0 | 0% | MATCH |
| annual 2026-01-25 | eps | 4.9 | 4.9 | 0 | 0% | MATCH |
| annual 2026-01-25 | free_cash_flow | 96676000000 | 96676000000 | 0 | 0% | MATCH |
| annual 2026-01-25 | roe | 76.33333969089534 | 76.33333969089534 | 0 | 0% | MATCH |
| annual 2026-01-25 | gross_margin | 71.06808435754708 | 71.06808435754708 | 0 | 0% | MATCH |
| annual 2026-01-25 | operating_margin | 60.38168363141272 | 60.38168363141272 | 0 | 0% | MATCH |
| annual 2025-01-26 | revenue | 130497000000 | 130497000000 | 0 | 0% | MATCH |
| annual 2025-01-26 | operating_income | 81453000000 | 81453000000 | 0 | 0% | MATCH |
| annual 2025-01-26 | net_income | 72880000000 | 72880000000 | 0 | 0% | MATCH |
| annual 2025-01-26 | eps | 2.94 | 2.94 | 0 | 0% | MATCH |
| annual 2025-01-26 | free_cash_flow | 60853000000 | 60853000000 | 0 | 0% | MATCH |
| annual 2025-01-26 | roe | 91.87288060811576 | 91.87288060811576 | 0 | 0% | MATCH |
| annual 2025-01-26 | gross_margin | 74.98869705816992 | 74.98869705816992 | 0 | 0% | MATCH |
| annual 2025-01-26 | operating_margin | 62.417526839697466 | 62.417526839697466 | 0 | 0% | MATCH |
| quarterly 2026-07-26 | revenue | 96221000000 | 96221000000 | 0 | 0% | MATCH |
| quarterly 2026-07-26 | operating_income | 63734000000 | 63734000000 | 0 | 0% | MATCH |
| quarterly 2026-07-26 | net_income | 59688000000 | 59688000000 | 0 | 0% | MATCH |
| quarterly 2026-07-26 | eps | 2.46 | 2.46 | 0 | 0% | MATCH |
| quarterly 2026-07-26 | free_cash_flow | 21400000000 | 21400000000 | 0 | 0% | MATCH |
| quarterly 2026-07-26 | roe | 26.06645005764595 | 26.06645005764595 | 0 | 0% | MATCH |
| quarterly 2026-07-26 | gross_margin | 74.97531723844068 | 74.97531723844068 | 0 | 0% | MATCH |
| quarterly 2026-07-26 | operating_margin | 66.23710000935347 | 66.23710000935347 | 0 | 0% | MATCH |
| quarterly 2026-04-26 | revenue | 81615000000 | 81615000000 | 0 | 0% | MATCH |
| quarterly 2026-04-26 | operating_income | 53536000000 | 53536000000 | 0 | 0% | MATCH |
| quarterly 2026-04-26 | net_income | 58321000000 | 58321000000 | 0 | 0% | MATCH |
| quarterly 2026-04-26 | eps | 2.39 | 2.39 | 0 | 0% | MATCH |
| quarterly 2026-04-26 | free_cash_flow | 48587000000 | 48587000000 | 0 | 0% | MATCH |
| quarterly 2026-04-26 | roe | 29.835681471704678 | 29.835681471704678 | 0 | 0% | MATCH |
| quarterly 2026-04-26 | gross_margin | 74.9335293757275 | 74.9335293757275 | 0 | 0% | MATCH |
| quarterly 2026-04-26 | operating_margin | 65.59578508852539 | 65.59578508852539 | 0 | 0% | MATCH |
| quarterly 2026-01-25 | revenue | 68127000000 | 68127000000 | 0 | 0% | MATCH |
| quarterly 2026-01-25 | operating_income | 44299000000 | 44299000000 | 0 | 0% | MATCH |
| quarterly 2026-01-25 | net_income | 42960000000 | 42960000000 | 0 | 0% | MATCH |
| quarterly 2026-01-25 | eps | 미확보 | 미확보 | 미확보 | — | 양쪽 NULL / 동일 |
| quarterly 2026-01-25 | free_cash_flow | 34904000000 | 34904000000 | 0 | 0% | MATCH |
| quarterly 2026-01-25 | roe | 27.312086361122233 | 27.312086361122233 | 0 | 0% | MATCH |
| quarterly 2026-01-25 | gross_margin | 74.99669734466511 | 74.99669734466511 | 0 | 0% | MATCH |
| quarterly 2026-01-25 | operating_margin | 65.02414608011507 | 65.02414608011507 | 0 | 0% | MATCH |
| quarterly 2025-10-26 | revenue | 57006000000 | 57006000000 | 0 | 0% | MATCH |
| quarterly 2025-10-26 | operating_income | 36010000000 | 36010000000 | 0 | 0% | MATCH |
| quarterly 2025-10-26 | net_income | 31910000000 | 31910000000 | 0 | 0% | MATCH |
| quarterly 2025-10-26 | eps | 1.3 | 1.3 | 0 | 0% | MATCH |
| quarterly 2025-10-26 | free_cash_flow | 22115000000 | 22115000000 | 0 | 0% | MATCH |
| quarterly 2025-10-26 | roe | 26.83835588786933 | 26.83835588786933 | 0 | 0% | MATCH |
| quarterly 2025-10-26 | gross_margin | 73.41157071185489 | 73.41157071185489 | 0 | 0% | MATCH |
| quarterly 2025-10-26 | operating_margin | 63.16878925025436 | 63.16878925025436 | 0 | 0% | MATCH |

## [12. 180/60 Rule 결과]

기존 구현의 실제 경계는 annual filingDelay > 180, quarterly filingDelay > 60이다. 요청 설명의 “이상”과 달리 현재 코드에서는 “초과”를 제외한다. 이번에 경계를 바꾸지 않았다.

NVDA 현재 50개 행에서 이 규칙으로 FY/Q가 NULL이 된 경우는 없다.
AAPL·MSFT·JPM·O도 각각 현재 연간 10개/분기 40개 모두 metadata가 채워졌다.

원본 전체 지연 공시 검사에서 JPM의 과거 2012 Q1 수정 공시가 발견됐다.

| period | form | accession | filed | end | 차이 |
| --- | --- | --- | --- | --- | --- |
| 2012 Q1 | 10-Q/A | 0000019617-12-000262 | 2012-08-09 | 2012-03-31 | 131일 |

이 늦은 수정 공시만으로 기간 정체성을 새로 확정하면 현재 60일 기준에 걸린다. 수정 공시 자체가 잘못된 공시라는 뜻은 아니다.
현재 보유 최근 40분기 밖의 사례이며 현재 metadata 결측을 만들지는 않았다. 정상 원공시 근거가 있는 경우와 구분해야 한다.

## [13. BusinessQuant 연결]

configured. 공식 /statements endpoint에서 NVDA만 조회했다.
Annual IS/CF, Quarter IS/CF 네 가지 본 비교 요청 모두 HTTP 200이었다.
연간은 2024-01-28~2026-01-25의 3개, 분기는 2023-10-29~2026-07-26의 12개 기간을 반환했다.
10y/3y를 요청했지만 실제 응답 metadata.note가 무료 호출에서 3년/12분기로 제한됨을 알렸다. 확보하지 못한 연도는 추정하지 않았다.

사용 파라미터: ticker=NVDA, statement=IS 또는 CF, frequency=Annual 또는 Quarter, period=10y 또는 3y.
공식 안내 기준의 endpoint이며 key는 환경 설정에서만 읽었다. [BusinessQuant 재무 API 문서](https://businessquant.com/docs/api/financial-statements)

## [14. FMP 연결]

[FMP BLOCKER]
MARKET_DATA_API_KEY / FMP_API_KEY 모두 missing. FMP 호출 0회, 확보 이력 없음.
가입·키 발급·추출·유료 호출을 하지 않았다. 아래 비교표의 FMP는 전부 미확보이며 일치했다고 주장하지 않는다.
FMP 공식 endpoint 문서는 확인했지만, 문서 확인은 실제 데이터 비교 성공이 아니다. [FMP 재무 문서](https://site.financialmodelingprep.com/developer/docs/stable/income-statement)

## [15. Annual SEC vs BusinessQuant vs FMP]

공통 연간 3개 × 6개 지표 = 18칸.
BQ Gross Margin은 원본 Gross Profit / Revenue × 100의 비교용 계산값이다. FMP는 전부 미확보다.
표의 FY는 SEC가 확인한 회계연도이며 BQ가 동일 FY를 명시했다고 가정하지 않는다.

| SEC FY/기간 · 종료일 | 지표 | SEC | BusinessQuant | FMP | BQ vs SEC % | FMP vs SEC % | 판정 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026 FY · 2026-01-25 | revenue | 215938000000 | 215938000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 FY · 2026-01-25 | operating_income | 130387000000 | 130387000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 FY · 2026-01-25 | net_income | 120067000000 | 120067000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 FY · 2026-01-25 | eps | 4.9 | 4.897895080362242 | 미확보 | -0.042958% | — | ROUNDING / FMP MISSING |
| 2026 FY · 2026-01-25 | gross_margin | 71.06808435754708 | 71.06808435754708 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 FY · 2026-01-25 | free_cash_flow | 96676000000 | 96676000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 FY · 2025-01-26 | revenue | 130497000000 | 130497000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 FY · 2025-01-26 | operating_income | 81453000000 | 81453000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 FY · 2025-01-26 | net_income | 72880000000 | 72880000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 FY · 2025-01-26 | eps | 2.94 | 2.938235768424448 | 미확보 | -0.060008% | — | ROUNDING / FMP MISSING |
| 2025 FY · 2025-01-26 | gross_margin | 74.98869705816992 | 74.98869705816992 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 FY · 2025-01-26 | free_cash_flow | 60853000000 | 60853000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 FY · 2024-01-28 | revenue | 60922000000 | 60922000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 FY · 2024-01-28 | operating_income | 32972000000 | 32972000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 FY · 2024-01-28 | net_income | 29760000000 | 29760000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 FY · 2024-01-28 | eps | 1.19 | 1.1932638331996792 | 미확보 | 0.274272% | — | ROUNDING / FMP MISSING |
| 2024 FY · 2024-01-28 | gross_margin | 72.71757329043696 | 72.71757329043696 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 FY · 2024-01-28 | free_cash_flow | 27021000000 | 27021000000 | 미확보 | 0% | — | MATCH / FMP MISSING |

## [16. Quarterly SEC vs BusinessQuant vs FMP]

공통 분기 12개 × 6개 지표 = 72칸.
BQ의 실제 date와 SEC 종료일을 매칭했다. normalizedDate나 달력월로 회사 FY/Q를 만들지 않았다.

| SEC FY/기간 · 종료일 | 지표 | SEC | BusinessQuant | FMP | BQ vs SEC % | FMP vs SEC % | 판정 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2027 Q2 · 2026-07-26 | revenue | 96221000000 | 96221000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2027 Q2 · 2026-07-26 | operating_income | 63734000000 | 63734000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2027 Q2 · 2026-07-26 | net_income | 59688000000 | 59688000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2027 Q2 · 2026-07-26 | eps | 2.46 | 2.4578134651019146 | 미확보 | -0.088884% | — | ROUNDING / FMP MISSING |
| 2027 Q2 · 2026-07-26 | gross_margin | 74.97531723844068 | 74.97531723844068 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2027 Q2 · 2026-07-26 | free_cash_flow | 21400000000 | 21400000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2027 Q1 · 2026-04-26 | revenue | 81615000000 | 81615000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2027 Q1 · 2026-04-26 | operating_income | 53536000000 | 53536000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2027 Q1 · 2026-04-26 | net_income | 58321000000 | 58321000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2027 Q1 · 2026-04-26 | eps | 2.39 | 2.3910868763068347 | 미확보 | 0.045476% | — | ROUNDING / FMP MISSING |
| 2027 Q1 · 2026-04-26 | gross_margin | 74.9335293757275 | 74.9335293757275 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2027 Q1 · 2026-04-26 | free_cash_flow | 48587000000 | 48587000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q4 · 2026-01-25 | revenue | 68127000000 | 68127000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q4 · 2026-01-25 | operating_income | 44299000000 | 44299000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q4 · 2026-01-25 | net_income | 42960000000 | 42960000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q4 · 2026-01-25 | eps | 미확보 | 1.7524679774822551 | 미확보 | — | — | MISSING / FMP MISSING |
| 2026 Q4 · 2026-01-25 | gross_margin | 74.99669734466511 | 74.99669734466511 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q4 · 2026-01-25 | free_cash_flow | 34904000000 | 34904000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q3 · 2025-10-26 | revenue | 57006000000 | 57006000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q3 · 2025-10-26 | operating_income | 36010000000 | 36010000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q3 · 2025-10-26 | net_income | 31910000000 | 31910000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q3 · 2025-10-26 | eps | 1.3 | 1.3033533472205203 | 미확보 | 0.257950% | — | ROUNDING / FMP MISSING |
| 2026 Q3 · 2025-10-26 | gross_margin | 73.41157071185489 | 73.41157071185489 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q3 · 2025-10-26 | free_cash_flow | 22115000000 | 22115000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q2 · 2025-07-27 | revenue | 46743000000 | 46743000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q2 · 2025-07-27 | operating_income | 28440000000 | 28440000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q2 · 2025-07-27 | net_income | 26422000000 | 26422000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q2 · 2025-07-27 | eps | 1.08 | 1.0770422305560086 | 미확보 | -0.273868% | — | ROUNDING / FMP MISSING |
| 2026 Q2 · 2025-07-27 | gross_margin | 72.4236784117408 | 72.4236784117408 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q2 · 2025-07-27 | free_cash_flow | 13470000000 | 13470000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q1 · 2025-04-27 | revenue | 44062000000 | 44062000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q1 · 2025-04-27 | operating_income | 21638000000 | 21638000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q1 · 2025-04-27 | net_income | 18775000000 | 18775000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q1 · 2025-04-27 | eps | 0.76 | 0.7628702612652879 | 미확보 | 0.377666% | — | ROUNDING / FMP MISSING |
| 2026 Q1 · 2025-04-27 | gross_margin | 60.52380736235305 | 60.52380736235305 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2026 Q1 · 2025-04-27 | free_cash_flow | 26187000000 | 26187000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q4 · 2025-01-26 | revenue | 39331000000 | 39331000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q4 · 2025-01-26 | operating_income | 24034000000 | 24034000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q4 · 2025-01-26 | net_income | 22091000000 | 22091000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q4 · 2025-01-26 | eps | 미확보 | 0.8906224802451218 | 미확보 | — | — | MISSING / FMP MISSING |
| 2025 Q4 · 2025-01-26 | gross_margin | 73.02890849457171 | 73.02890849457171 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q4 · 2025-01-26 | free_cash_flow | 15552000000 | 15552000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q3 · 2024-10-27 | revenue | 35082000000 | 35082000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q3 · 2024-10-27 | operating_income | 21869000000 | 21869000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q3 · 2024-10-27 | net_income | 19309000000 | 19309000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q3 · 2024-10-27 | eps | 0.78 | 0.77940582869137 | 미확보 | -0.076176% | — | ROUNDING / FMP MISSING |
| 2025 Q3 · 2024-10-27 | gross_margin | 74.55675275069837 | 74.55675275069837 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q3 · 2024-10-27 | free_cash_flow | 16814000000 | 16814000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q2 · 2024-07-28 | revenue | 30040000000 | 30040000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q2 · 2024-07-28 | operating_income | 18642000000 | 18642000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q2 · 2024-07-28 | net_income | 16599000000 | 16599000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q2 · 2024-07-28 | eps | 0.67 | 0.6680215711526079 | 미확보 | -0.295288% | — | ROUNDING / FMP MISSING |
| 2025 Q2 · 2024-07-28 | gross_margin | 75.14647137150466 | 75.14647137150466 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q2 · 2024-07-28 | free_cash_flow | 13511000000 | 13511000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q1 · 2024-04-28 | revenue | 26044000000 | 26044000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q1 · 2024-04-28 | operating_income | 16909000000 | 16909000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q1 · 2024-04-28 | net_income | 14881000000 | 14881000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q1 · 2024-04-28 | eps | 0.6 | 0.5978706307754118 | 미확보 | -0.354895% | — | ROUNDING / FMP MISSING |
| 2025 Q1 · 2024-04-28 | gross_margin | 78.35201965903855 | 78.35201965903855 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2025 Q1 · 2024-04-28 | free_cash_flow | 14976000000 | 14976000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 Q4 · 2024-01-28 | revenue | 22103000000 | 22103000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 Q4 · 2024-01-28 | operating_income | 13614000000 | 13614000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 Q4 · 2024-01-28 | net_income | 12285000000 | 12285000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 Q4 · 2024-01-28 | eps | 미확보 | 0.4925821972734563 | 미확보 | — | — | MISSING / FMP MISSING |
| 2024 Q4 · 2024-01-28 | gross_margin | 75.9670632945754 | 75.9670632945754 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 Q4 · 2024-01-28 | free_cash_flow | 11245000000 | 11245000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 Q3 · 2023-10-29 | revenue | 18120000000 | 18120000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 Q3 · 2023-10-29 | operating_income | 10417000000 | 10417000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 Q3 · 2023-10-29 | net_income | 9243000000 | 9243000000 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 Q3 · 2023-10-29 | eps | 0.37 | 0.3706094627105052 | 미확보 | 0.164720% | — | ROUNDING / FMP MISSING |
| 2024 Q3 · 2023-10-29 | gross_margin | 73.9514348785872 | 73.9514348785872 | 미확보 | 0% | — | MATCH / FMP MISSING |
| 2024 Q3 · 2023-10-29 | free_cash_flow | 7054000000 | 7054000000 | 미확보 | 0% | — | MATCH / FMP MISSING |

## [17. 지표별 일치도]

아래 BQ 비교 통계의 Missing은 SEC 또는 BQ 값 결측을 뜻한다. FMP 결측은 별도 열로 분리했다.

| 지표 | 비교 후보 | Exact | ROUNDING | Small | Material | Missing | Definition | FMP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| revenue | 15 | 15 | 0 | 0 | 0 | 0 | 0 | 15건 미확보 |
| operating_income | 15 | 15 | 0 | 0 | 0 | 0 | 0 | 15건 미확보 |
| net_income | 15 | 15 | 0 | 0 | 0 | 0 | 0 | 15건 미확보 |
| eps | 15 | 0 | 12 | 0 | 0 | 3 | 0 | 15건 미확보 |
| gross_margin | 15 | 15 | 0 | 0 | 0 | 0 | 0 | 15건 미확보 |
| free_cash_flow | 15 | 15 | 0 | 0 | 0 | 0 | 0 | 15건 미확보 |

총 90칸: MATCH 75, ROUNDING 12, MISSING 3.
SMALL DIFFERENCE 0, MATERIAL DIFFERENCE 0, 확인된 DEFINITION DIFFERENCE 0.
EPS ROUNDING은 BQ 희석 EPS를 소수점 둘째 자리로 반올림했을 때 SEC 희석 EPS와 같은 경우다. 차이 %를 숨기지 않았다.
그 밖의 지표는 원값 정확 일치 또는 매우 작은 부동소수점 오차를 구분하며, <1%를 SMALL, 그 외를 MATERIAL로 분류한다. NULL과 0은 구분한다.
확인된 정의 차이가 없다는 뜻이지, 모든 공급원의 모든 지표 정의가 동일하다는 증명은 아니다.

## [18. Fiscal Period 비교]

| 종료일 | SEC FY/기간 | BQ periodType | BQ FY/Q 번호 | FMP FY/Q |
| --- | --- | --- | --- | --- |
| 2026-01-25 | 2026 FY | Annual | 반환 필드 없음 | 미확보 |
| 2025-01-26 | 2025 FY | Annual | 반환 필드 없음 | 미확보 |
| 2024-01-28 | 2024 FY | Annual | 반환 필드 없음 | 미확보 |
| 2026-07-26 | 2027 Q2 | Quarter | 반환 필드 없음 | 미확보 |
| 2026-04-26 | 2027 Q1 | Quarter | 반환 필드 없음 | 미확보 |
| 2026-01-25 | 2026 Q4 | Quarter | 반환 필드 없음 | 미확보 |
| 2025-10-26 | 2026 Q3 | Quarter | 반환 필드 없음 | 미확보 |
| 2025-07-27 | 2026 Q2 | Quarter | 반환 필드 없음 | 미확보 |
| 2025-04-27 | 2026 Q1 | Quarter | 반환 필드 없음 | 미확보 |
| 2025-01-26 | 2025 Q4 | Quarter | 반환 필드 없음 | 미확보 |
| 2024-10-27 | 2025 Q3 | Quarter | 반환 필드 없음 | 미확보 |
| 2024-07-28 | 2025 Q2 | Quarter | 반환 필드 없음 | 미확보 |
| 2024-04-28 | 2025 Q1 | Quarter | 반환 필드 없음 | 미확보 |
| 2024-01-28 | 2024 Q4 | Quarter | 반환 필드 없음 | 미확보 |
| 2023-10-29 | 2024 Q3 | Quarter | 반환 필드 없음 | 미확보 |

BQ 실제 value 항목에는 date, normalizedDate, periodType, reportedValue가 있었다. 이번 응답에서 명시적인 fiscalYear, fiscalQuarter, filing date, form, accession은 확보되지 않았다.
따라서 실제 종료일과 Annual/Quarter 종류는 일치하지만, Q2 FY2027 같은 회계 표기를 BQ와 독립 교차검증했다고 말할 수 없다.
SEC fy/fp와 같은 accession의 실제 최신 기간으로 회사 회계기간을 확인했다. FMP 기간 비교는 키가 없어 미완료다.

## [19. EPS 차이 분석]

SEC EarningsPerShareDiluted와 BQ EPS (Diluted)를 비교했다. Basic EPS로 대체하지 않았다.

| 기간 | SEC diluted EPS | BQ diluted EPS | BQ−SEC | 차이 % | 판정 |
| --- | --- | --- | --- | --- | --- |
| 2026 FY | 4.9 | 4.897895080362242 | -0.0021049196377580515 | -0.042958% | ROUNDING |
| 2025 FY | 2.94 | 2.938235768424448 | -0.0017642315755521665 | -0.060008% | ROUNDING |
| 2024 FY | 1.19 | 1.1932638331996792 | 0.003263833199679267 | 0.274272% | ROUNDING |
| 2027 Q2 | 2.46 | 2.4578134651019146 | -0.0021865348980854016 | -0.088884% | ROUNDING |
| 2027 Q1 | 2.39 | 2.3910868763068347 | 0.0010868763068345721 | 0.045476% | ROUNDING |
| 2026 Q4 | 미확보 | 1.7524679774822551 | 미확보 | — | MISSING |
| 2026 Q3 | 1.3 | 1.3033533472205203 | 0.0033533472205202752 | 0.257950% | ROUNDING |
| 2026 Q2 | 1.08 | 1.0770422305560086 | -0.002957769443991509 | -0.273868% | ROUNDING |
| 2026 Q1 | 0.76 | 0.7628702612652879 | 0.002870261265287888 | 0.377666% | ROUNDING |
| 2025 Q4 | 미확보 | 0.8906224802451218 | 미확보 | — | MISSING |
| 2025 Q3 | 0.78 | 0.77940582869137 | -0.0005941713086300426 | -0.076176% | ROUNDING |
| 2025 Q2 | 0.67 | 0.6680215711526079 | -0.0019784288473921885 | -0.295288% | ROUNDING |
| 2025 Q1 | 0.6 | 0.5978706307754118 | -0.0021293692245881735 | -0.354895% | ROUNDING |
| 2024 Q4 | 미확보 | 0.4925821972734563 | 미확보 | — | MISSING |
| 2024 Q3 | 0.37 | 0.3706094627105052 | 0.0006094627105052153 | 0.164720% | ROUNDING |

BQ 값은 소수점 자릿수가 길고 SEC 값은 소수점 둘째 자리로 신고돼, 값이 있는 12개 기간은 모두 반올림 시 일치했다.
SEC Q4 EPS가 NULL인 2024-01-28, 2025-01-26, 2026-01-25는 BQ 값을 복사하거나 FY EPS−9M EPS로 보충하지 않았다.
오래된 SEC EPS는 공시 시기별 분할 기준이 섞일 위험이 남는다. 이번 공통 최근 3년 일치가 FY2017~2022의 분할 보정까지 증명하지는 않는다.
restatement와 최신 비교값 선택도 기존 정책 그대로다. EPS 정책은 수정하지 않았다.

## [20. FCF 차이 분석]

기존 정의 operating_cash_flow − abs(capital_expenditure)를 유지했다.
NVDA 공통 연간 3개·분기 12개의 BQ Free Cash Flow 필드와 SEC 계산값은 15/15 정확히 일치했다.

BQ API 필드명은 Free Cash Flow이며 현금흐름 응답에 Cash from Operations와 Capital Expenditures가 존재했다.
공식 일반 API 안내와 이번 필드 설명만으로 모든 기업에 적용되는 BQ FCF의 상세 태그·분할·수정공시 정책까지 확정할 수는 없었다. 수치 일치와 보편적인 정의 동일성을 구분한다.
FMP 정의·실제값 비교는 미완료다. 정의가 다르다고 확인된 사례는 없어 DEFINITION DIFFERENCE를 임의 부여하지 않았다.
FY2017~FY2021 SEC FCF NULL은 기존 태그/선택 범위 제한으로, 이번 metadata 보완의 수치 회귀가 아니다. 변경하지 않았다.

## [21. Net Margin UI 준비 여부]

Revenue와 Net Income 기준 데이터 준비: YES.
실제 SEC 재처리 연간 10개·분기 40개 모두 두 값과 회사 기간 식별이 있어 Net Income / Revenue × 100 계산이 가능하다.
BQ 공통 기간 15개에서도 동일한 R/NI가 정확히 일치하므로 비교용 Net Margin도 일치한다.

대표 비교용 계산: FY2026 Annual 55.60253406070261%, FY2027 Q2 62.03219671381507%.
이번에는 DB 저장 열·계산 로직·UI·차트를 추가하지 않았다.
이는 계산 기반 준비이지 EPS/FCF 등 모든 재무 차트가 완성됐다는 뜻이 아니다.

## [22. 추가 종목 Smoke Test]

AAPL·MSFT·JPM·O 공식 CompanyFacts 요청은 모두 HTTP 200.
각각 Annual 10/10, Quarterly 40/40에서 FY, period, start가 모두 채워졌으며 NULL 기간은 없었다.

| 종목 | 구분 | FY | 기간 | 시작 | 종료 |
| --- | --- | --- | --- | --- | --- |
| AAPL | annual | 2025 | FY | 2024-09-29 | 2025-09-27 |
| AAPL | annual | 2024 | FY | 2023-10-01 | 2024-09-28 |
| AAPL | quarterly | 2026 | Q3 | 2026-03-29 | 2026-06-27 |
| AAPL | quarterly | 2026 | Q2 | 2025-12-28 | 2026-03-28 |
| AAPL | quarterly | 2026 | Q1 | 2025-09-28 | 2025-12-27 |
| AAPL | quarterly | 2025 | Q4 | 2025-06-29 | 2025-09-27 |
| MSFT | annual | 2026 | FY | 2025-07-01 | 2026-06-30 |
| MSFT | annual | 2025 | FY | 2024-07-01 | 2025-06-30 |
| MSFT | quarterly | 2026 | Q4 | 2026-04-01 | 2026-06-30 |
| MSFT | quarterly | 2026 | Q3 | 2026-01-01 | 2026-03-31 |
| MSFT | quarterly | 2026 | Q2 | 2025-10-01 | 2025-12-31 |
| MSFT | quarterly | 2026 | Q1 | 2025-07-01 | 2025-09-30 |
| JPM | annual | 2025 | FY | 2025-01-01 | 2025-12-31 |
| JPM | annual | 2024 | FY | 2024-01-01 | 2024-12-31 |
| JPM | quarterly | 2026 | Q2 | 2026-04-01 | 2026-06-30 |
| JPM | quarterly | 2026 | Q1 | 2026-01-01 | 2026-03-31 |
| JPM | quarterly | 2025 | Q4 | 2025-10-01 | 2025-12-31 |
| JPM | quarterly | 2025 | Q3 | 2025-07-01 | 2025-09-30 |
| O | annual | 2025 | FY | 2025-01-01 | 2025-12-31 |
| O | annual | 2024 | FY | 2024-01-01 | 2024-12-31 |
| O | quarterly | 2026 | Q2 | 2026-04-01 | 2026-06-30 |
| O | quarterly | 2026 | Q1 | 2026-01-01 | 2026-03-31 |
| O | quarterly | 2025 | Q4 | 2025-10-01 | 2025-12-31 |
| O | quarterly | 2025 | Q3 | 2025-07-01 | 2025-09-30 |

AAPL의 12월 종료가 FY2026 Q1이고 MSFT의 6월 종료가 FY2026 Q4인 것도 원본 근거로 확인했다. 달력 분기를 그대로 붙이지 않았다.
[12]의 JPM 과거 수정 공시를 제외한 검사 대상의 지연 공시 후보는 발견되지 않았다. 최신 범위 정상 판정과 전체 역사상의 모든 늦은 공시 검증은 구분한다.

## [23. Test 결과]

시작 기존 92개를 수정하지 않고 유지했다. 새 검증 테스트 8개를 추가했다.

| 검사 | 결과 |
| --- | --- |
| npm test | 100 PASS / 0 FAIL |
| 신규 감사 도구 테스트 | 8 PASS / 0 FAIL |
| 실패 테스트명 | 없음 |
| npm run check | PASS |
| node --check scripts/sec-financial-audit.mjs | PASS |
| git diff --check | PASS · Git CRLF 안내 경고만 존재 |

실제 API 검증은 별도로 수행했다. 합성 unit test를 실제 NVDA 응답이라고 표시하지 않았다.
UI 변경이 없으므로 PIN·관심종목·포트폴리오 전체 브라우저 조작 회귀는 이번 감사 범위에서 실행하지 않았다. 기존 관련 파일·저장 형식은 변경하지 않았다.

## [24. 수정 파일]

| 파일 | 이번 변경 이유 |
| --- | --- |
| worker/.dev.vars · Git 제외 | 사용자 승인 연락 이메일로 SEC_USER_AGENT 설정 |
| scripts/sec-financial-audit.mjs · 신규 | 1회 진단 조회, 메모리 SEC 재처리, 안전한 원본/출처 요약과 BQ 비교 |
| tests/sec-financial-audit.test.js · 신규 | 결측/0, 희석 EPS, 날짜 매칭, 비교 전용 마진, IS·CF 분리, 메모리 DB 한정 검증 |
| docs/sec-financial-phase1-5-report.md · 신규 | 실제 응답 결과·비교표·제약·운영 적용 판단 기록 |

[1]의 Phase 1 파일은 이전 작업 변경이며 이번에 다시 수정하지 않았다.
index.html, style.css, app.js, 차트·배당 UI, 모든 기존 migration, 기존 92개 테스트는 이번에 변경하지 않았다.
API key 하드코딩은 하지 않았다.

## [25. Production 변경 여부]

| 항목 | 실행 |
| --- | --- |
| production DB write | NO |
| production migration | NO |
| production deployment | NO |
| BusinessQuant/FMP 운영 저장 | NO |
| BusinessQuant/FMP를 SEC provenance로 저장 | NO |

운영 API 조회는 읽기 전용이었다. 운영 예약작업을 새로 실행하거나 변경하지 않았다.

## [26. 발견된 문제]

- FMP 로컬 키 부재로 완전한 3자 비교는 미완료다.
- BQ 실제 무료 응답은 연간 3개·분기 12개로 제한된다. 10년을 조회했다고 주장하지 않는다.
- BQ 응답의 명시적 FY/Q·filing metadata가 없어 기간 이름의 독립 교차검증은 미완료다.
- SEC Q4 EPS 결측, 과거 EPS 분할 기준 혼재, 오래된 FCF 후보 태그 부족은 기존 정책의 남은 위험이다. 이번에 변경하지 않았다.
- reported_date는 선택된 후속 공시일일 수 있다. 최초 해당기간 공시일과 동일하다고 표시하지 않아야 한다.
- 운영 Cloudflare의 SEC_USER_AGENT 설정과 실제 전송 헤더는 이번 로컬 감사로 확인하지 못했다.
- 운영 전체 실행자를 합산하는 10회/초 중앙 제한은 현재 코드에 없고 이번에 추가하지 않았다.
- 검증 입력 실수로 BQ에 키 없는 요청 1회가 발생해 401을 받았다. 인증된 본 비교 4회는 모두 200이므로 유효 키 오류로 해석하지 않는다. 자동 재시도는 하지 않았다.
- schema 변경 필요, 현재 기간 metadata 누락, 표본 수치의 대량 변경은 발견하지 못했다.

## [27. 다음 단계 권고]

판정: A. Phase 1의 기간·출처 저장 보완은 실제 데이터로 검증됐으며 운영 migration/deploy 준비 가능.

이 판단은 metadata/provenance 보완인 0016에 한정한다. FMP까지 3자 검증 완료나 과거 EPS/FCF 차트의 완전성 승인으로 확대하지 않는다.
근거는 실제 5종목의 기간 coverage, NVDA 실제 SEC 출처 생성, 최신 48칸 숫자 불변, BQ 공통 90칸의 정확 일치·반올림·결측 분류다.

운영 적용 전에는 사용자 별도 승인을 받고, 운영 SEC_USER_AGENT 설정 확인과 현재 DB 백업/마이그레이션 적용 후 제한된 종목의 실제 읽기 검증을 수행해야 한다.
이번에는 승인 요청이나 운영 변경을 진행하지 않았다. FMP 비교는 사용자가 로컬 키를 설정하면 별도 진단으로 보완할 수 있다.

| 최종 확인 | YES / NO |
| --- | --- |
| 1. 실제 NVDA SEC 원본 재처리 성공 | YES |
| 2. NVDA Annual FY/FQ metadata 충분 | YES |
| 3. NVDA Quarterly FY/FQ metadata 충분 | YES |
| 4. 2026-07-26이 실제 근거로 Q2 FY2027 | YES |
| 5. 실제 SEC provenance 정상 동작 | YES |
| 6. 기존 numeric values 예상치 못한 대량 변화 없음 | YES · 비교한 48칸 기준 |
| 7. BusinessQuant 비교 성공 | YES · 실제 3 Annual / 12 Quarter 범위 |
| 8. FMP 비교 성공 | NO · 로컬 키 없음 |
| 9. Revenue/Net Income 기준 Net Margin 차트 데이터 준비 | YES · 구현·저장은 안 함 |
| 10. 현 상태에서 0016 운영 적용 가능 판단 | YES · metadata 보완 범위, 별도 운영 승인/설정 확인 전제 |
