# SEC 재무 Phase 1.6A 재개 · 운영 검증 결과

작성일: 2026-09-30 · Asia/Seoul.
결론: Phase 1.6A 운영 검증 완료. [ROLLOUT MODE WARNING]은 유지되므로 다음 단계는 별도 승인이 필요하다.
과거 중단 보고서는 이력으로 보존했고, 이 문서는 재개 결과만 기록한다.

## [1. Blocker 수정]

수정한 실행 코드: scripts/sec-financial-rollout-worker.js.
수정한 테스트: tests/sec-financial-rollout.test.js.
Workers가 지원하는 redirect:manual로 변경하고 3xx는 SEC_PREFLIGHT_REDIRECT_ERROR로 명시적으로 거부한다.
HTTP status/content-type을 먼저 확인하며 200 JSON만 파싱한다.
403/429/5xx·non-JSON·JSON parse 실패에도 원래 SEC status와 content-type을 보존한다.
오류 응답 원문·Location·Secret·이메일 값은 로그에 남기지 않는다.

사전 확인의 공식 SEC 원본은 메모리에만 보관하며 NVDA 처리에서 재사용한다. DB에는 사전 확인으로 쓰지 않는다.
회계 metadata 판단·금액 선택·EPS/FCF/ROE 정책·0016·UI·배당 코드는 이번 수정에서 바꾸지 않았다.
0017은 생성하지 않았다. 기존 Phase 1/1.5 및 소규모 rollout 변경을 보존해 배포했다.
커밋·push·Pages 배포는 하지 않았다.

## [2. 추가 테스트]

기존 104개에 7개 추가: 총 111, PASS 111, FAIL 0.
기존 정상 예제에 redirect:manual 검증을 추가했고 기대 수준을 낮추거나 기존 테스트를 삭제하지 않았다.
302/403/429/500 HTML, 200 non-JSON, 200 손상 JSON, JSON 구조 오류를 검증한다.
302 테스트는 외부 fetch 1회만 발생하고 Location/원문이 진단 결과에 나오지 않는지 확인한다.

배포 전과 최종 점검 모두 npm test, npm run check, git diff --check PASS.
helper 별도 node --check PASS. CRLF 전환 안내는 Git 경고이며 공백 오류는 아니다.

## [3. Rollout Manual Mode 영향]

[ROLLOUT MODE WARNING]

SEC_FINANCIAL_ROLLOUT_MODE=manual은 runFundamentalBatch를 seedJobs 이전에 반환시킨다.
따라서 정기 SEC 재무뿐 아니라 같은 큐의 FMP 회사정보 profile 갱신도 중지한다.
일반 /api/fundamentals/run 실행도 이 큐를 정상 진행시키지 못한다.
가격·Massive 일봉·독립 Business Quant 배당 파이프라인·저장값 읽기는 이 설정으로 중지되지 않는다.
예약 Cron 자체를 삭제한 것이 아니라 해당 재무/회사정보 큐가 paused를 반환하는 것이다.

자동 만료는 없다. 다음 Phase에서 사용자 승인 → Phase 1.6B 전체 metadata 검증 →
완료 확인 후 별도 승인된 정상 모드 복원 순서를 권한다.
정상화 때 이 설정을 해제하거나 normal로 바꾸는 설정 배포가 필요하며, 복원 결과도 확인해야 한다.
이번에는 임의 복원·전역 큐 강제 실행을 하지 않았다.

## [4. Remote SEC Preflight]

공식 wrangler dev --remote에서 GET /sec-preflight 정확히 1회 실행했다.
검증 preview HTTP 200, 실제 SEC HTTP 200, content-type application/json.
SEC_USER_AGENT configured=true, databaseWrite=false.
운영 Worker의 기존 Secret을 inherit했으며 실제 값은 출력·교체하지 않았다.
사전 확인 반복 요청은 없었다.

검증 preview는 localhost 8796을 통해 접근하는 비공개 Wrangler 개발 채널이고,
실제 실행 위치는 Cloudflare이며 D1 binding은 운영 DB다.
새 공개 진단 endpoint를 production Worker에 추가하지 않았다.
unsafe/inherit는 Wrangler의 실험적 설정 경고가 있지만 실제 SEC와 D1 접근이 성공했다.
검증 완료 후 preview를 Ctrl+C로 종료했다. 종료 코드 1은 의도한 개발 서버 중단이며 운영 장애가 아니다.

## [5. Migration 0016]

운영 미적용 목록에 0016 하나만 있음을 확인한 뒤 적용했다. 실행 YES, 성공 YES.
0016은 fiscal_year, fiscal_period, period_start 추가와 출처 테이블/인덱스 생성뿐이다.
0016 파일은 수정하지 않았고 0017 생성·기존 데이터 삭제는 하지 않았다.
출처 테이블과 idx_financial_metric_provenance_filing 인덱스 존재를 확인했다.

Worker: us-stock-dashboard-api.
D1: us-stock-pro · binding DB · 698ab9b8-4573-40c7-b119-d7b1d681abc8.

적용 전 Time Travel bookmark:
```text
0000094d-00000000-000050f6-1e2e9297b90a41b8c4402f7128364095
```
복구는 실행하지 않았다. DB 전체 복원은 다른 정상 write도 되돌리므로 별도 승인·손실 검토가 필요하다.
bookmark는 보존기간이 있는 복구 지점이며 영구 백업이 아니다.
공식 복구 안내: https://developers.cloudflare.com/d1/reference/time-travel/

## [6. Migration 후 Numeric 보존]

financial_metrics 500행을 유지했다.
정렬한 500행의 키 + 8개 지표 JSON 전체 SHA-256을 migration 직전/직후 비교했고 동일했다.
NVDA 50행 × 8개 지표도 그대로였다. 변경 0건.
최종 5종목 재처리 후에도 전체 500행의 같은 digest가 동일했다.

```text
5590e9f97020ef87c310fa964fafec9519ff9967b40cf00317917fbd84c0acaf
```

사전 조회 과정에 잘못된 period_end 컬럼명과 큰 CLI 출력의 로컬 캡처 잘림이 있었다.
읽기 전용 조회 문제였으며 migration 실패·원격 SEC 실패가 아니다.
실제 컬럼 fiscal_period_end를 사용하고 CLI 출력을 프로세스 내부에서 해시한 뒤 정상 baseline을 확보했다.
해당 진단 조회로 DB write는 발생하지 않았다.

## [7. Worker Deploy]

0016 성공 및 numeric 보존 확인 후 production 배포했다. 실행 YES, 성공 YES.
배포 명령은 --keep-vars를 사용했고 Secret 추가·교체·삭제는 하지 않았다.
Version ID: 0ab15eb7-3ac3-49f1-8350-1172b099442d.
운영 주소: https://us-stock-dashboard-api.771yoyo.workers.dev

직후 /api/health, /api/companies, /api/companies/NVDA, /api/companies/O 모두 HTTP 200.
회사 목록 10개, 대상 financials 50행을 유지한다.
기존 재무 응답 필드를 유지하고 fiscalYear/fiscalPeriod/periodStart 세 필드만 추가했다.
재처리 전 이 세 값이 NULL인 것도 정상 확인했다.

## [8. NVDA]

재처리 POST 정확히 1회, HTTP 200. 연간 FY/Period/Start 각각 10/10, 분기 각각 40/40.
기존 50행 × 8개 지표 비교: 변경 0건. 전체 provenance 618행.
최신 분기의 8개 대상 중 값이 있는 지표 8개의 출처를 확인했다. NULL 지표에 출처를 임의 생성하지 않았다.

최근 Annual 2개 + Quarterly 4개 × 8개 = 48개 값 비교 모두 PASS.
전체 50행 × 8개 비교도 변경 0건.
2026-07-26은 Q2 FY2027, 시작 2026-04-27.
2026-01-25 annual은 FY2026, quarterly는 Q4 FY2026으로 별도 저장된다.
Q4 EPS NULL을 유지했다. EPS 누적 차감·분할 조정·ROE 정책 변경은 없다.

최신 분기의 8개 지표 출처:

| 지표 | 계산 유형 | SEC tag | form | accession | filed | unit | 입력 참조 수 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| eps | direct | EarningsPerShareDiluted | 10-Q | 0001045810-26-000075 | 2026-08-26 | USD/shares | 1 |
| free_cash_flow | derived | 파생값: 입력 참조 확인 | 입력 참조 | 입력 참조 | 입력 참조 | USD | 4 |
| gross_margin | derived | 파생값: 입력 참조 확인 | 입력 참조 | 입력 참조 | 입력 참조 | % | 2 |
| net_income | direct | NetIncomeLoss | 10-Q | 0001045810-26-000075 | 2026-08-26 | USD | 1 |
| operating_income | direct | OperatingIncomeLoss | 10-Q | 0001045810-26-000075 | 2026-08-26 | USD | 1 |
| operating_margin | derived | 파생값: 입력 참조 확인 | 입력 참조 | 입력 참조 | 입력 참조 | % | 2 |
| revenue | direct | Revenues | 10-Q | 0001045810-26-000075 | 2026-08-26 | USD | 1 |
| roe | derived | 파생값: 입력 참조 확인 | 입력 참조 | 입력 참조 | 입력 참조 | % | 2 |

파생값의 root tag/form/accession/filed가 NULL인 것은 입력별 공시가 다를 수 있기 때문이다.
각 source_refs_json 안의 tag/form/accession/filed/start/end/unit/value를 실제 운영 D1에서 확인했다.
FCF는 OCF 누적 차감 2건 + Capex 누적 차감 2건 총 4개 입력 참조.
OCF 24,077,000,000 − Capex 2,677,000,000 = FCF 21,400,000,000.
ROE는 NetIncomeLoss와 StockholdersEquity 입력 2개를 보존한다.
근거 없는 EPS/Q4 신규값이나 파생 지표에 단일 공시를 임의 배정하지 않았다.

| 기간 | 지표 | Before | After | 차이 | 판정 |
| --- | --- | --- | --- | --- | --- |
| annual 2026-01-25 | revenue | 215938000000 | 215938000000 | 0 | PASS |
| annual 2026-01-25 | operating_income | 130387000000 | 130387000000 | 0 | PASS |
| annual 2026-01-25 | net_income | 120067000000 | 120067000000 | 0 | PASS |
| annual 2026-01-25 | eps | 4.9 | 4.9 | 0 | PASS |
| annual 2026-01-25 | free_cash_flow | 96676000000 | 96676000000 | 0 | PASS |
| annual 2026-01-25 | roe | 76.33333969089534 | 76.33333969089534 | 0 | PASS |
| annual 2026-01-25 | gross_margin | 71.06808435754708 | 71.06808435754708 | 0 | PASS |
| annual 2026-01-25 | operating_margin | 60.38168363141272 | 60.38168363141272 | 0 | PASS |
| annual 2025-01-26 | revenue | 130497000000 | 130497000000 | 0 | PASS |
| annual 2025-01-26 | operating_income | 81453000000 | 81453000000 | 0 | PASS |
| annual 2025-01-26 | net_income | 72880000000 | 72880000000 | 0 | PASS |
| annual 2025-01-26 | eps | 2.94 | 2.94 | 0 | PASS |
| annual 2025-01-26 | free_cash_flow | 60853000000 | 60853000000 | 0 | PASS |
| annual 2025-01-26 | roe | 91.87288060811576 | 91.87288060811576 | 0 | PASS |
| annual 2025-01-26 | gross_margin | 74.98869705816992 | 74.98869705816992 | 0 | PASS |
| annual 2025-01-26 | operating_margin | 62.417526839697466 | 62.417526839697466 | 0 | PASS |
| quarterly 2026-07-26 | revenue | 96221000000 | 96221000000 | 0 | PASS |
| quarterly 2026-07-26 | operating_income | 63734000000 | 63734000000 | 0 | PASS |
| quarterly 2026-07-26 | net_income | 59688000000 | 59688000000 | 0 | PASS |
| quarterly 2026-07-26 | eps | 2.46 | 2.46 | 0 | PASS |
| quarterly 2026-07-26 | free_cash_flow | 21400000000 | 21400000000 | 0 | PASS |
| quarterly 2026-07-26 | roe | 26.06645005764595 | 26.06645005764595 | 0 | PASS |
| quarterly 2026-07-26 | gross_margin | 74.97531723844068 | 74.97531723844068 | 0 | PASS |
| quarterly 2026-07-26 | operating_margin | 66.23710000935347 | 66.23710000935347 | 0 | PASS |
| quarterly 2026-04-26 | revenue | 81615000000 | 81615000000 | 0 | PASS |
| quarterly 2026-04-26 | operating_income | 53536000000 | 53536000000 | 0 | PASS |
| quarterly 2026-04-26 | net_income | 58321000000 | 58321000000 | 0 | PASS |
| quarterly 2026-04-26 | eps | 2.39 | 2.39 | 0 | PASS |
| quarterly 2026-04-26 | free_cash_flow | 48587000000 | 48587000000 | 0 | PASS |
| quarterly 2026-04-26 | roe | 29.835681471704678 | 29.835681471704678 | 0 | PASS |
| quarterly 2026-04-26 | gross_margin | 74.9335293757275 | 74.9335293757275 | 0 | PASS |
| quarterly 2026-04-26 | operating_margin | 65.59578508852539 | 65.59578508852539 | 0 | PASS |
| quarterly 2026-01-25 | revenue | 68127000000 | 68127000000 | 0 | PASS |
| quarterly 2026-01-25 | operating_income | 44299000000 | 44299000000 | 0 | PASS |
| quarterly 2026-01-25 | net_income | 42960000000 | 42960000000 | 0 | PASS |
| quarterly 2026-01-25 | eps | NULL | NULL | 0 | PASS |
| quarterly 2026-01-25 | free_cash_flow | 34904000000 | 34904000000 | 0 | PASS |
| quarterly 2026-01-25 | roe | 27.312086361122233 | 27.312086361122233 | 0 | PASS |
| quarterly 2026-01-25 | gross_margin | 74.99669734466511 | 74.99669734466511 | 0 | PASS |
| quarterly 2026-01-25 | operating_margin | 65.02414608011507 | 65.02414608011507 | 0 | PASS |
| quarterly 2025-10-26 | revenue | 57006000000 | 57006000000 | 0 | PASS |
| quarterly 2025-10-26 | operating_income | 36010000000 | 36010000000 | 0 | PASS |
| quarterly 2025-10-26 | net_income | 31910000000 | 31910000000 | 0 | PASS |
| quarterly 2025-10-26 | eps | 1.3 | 1.3 | 0 | PASS |
| quarterly 2025-10-26 | free_cash_flow | 22115000000 | 22115000000 | 0 | PASS |
| quarterly 2025-10-26 | roe | 26.83835588786933 | 26.83835588786933 | 0 | PASS |
| quarterly 2025-10-26 | gross_margin | 73.41157071185489 | 73.41157071185489 | 0 | PASS |
| quarterly 2025-10-26 | operating_margin | 63.16878925025436 | 63.16878925025436 | 0 | PASS |

## [9. AAPL]

재처리 POST 정확히 1회, HTTP 200. 연간 FY/Period/Start 각각 10/10, 분기 각각 40/40.
기존 50행 × 8개 지표 비교: 변경 0건. 전체 provenance 645행.
최신 분기의 8개 대상 중 값이 있는 지표 8개의 출처를 확인했다. NULL 지표에 출처를 임의 생성하지 않았다.

## [10. MSFT]

재처리 POST 정확히 1회, HTTP 200. 연간 FY/Period/Start 각각 10/10, 분기 각각 40/40.
기존 50행 × 8개 지표 비교: 변경 0건. 전체 provenance 604행.
최신 분기의 8개 대상 중 값이 있는 지표 7개의 출처를 확인했다. NULL 지표에 출처를 임의 생성하지 않았다.
최신 Q4 EPS NULL이며 해당 EPS 출처 행을 생성하지 않은 것이 기존 정책과 일치한다.

## [11. JPM]

재처리 POST 정확히 1회, HTTP 200. 연간 FY/Period/Start 각각 10/10, 분기 각각 40/40.
기존 50행 × 8개 지표 비교: 변경 0건. 전체 provenance 390행.
최신 분기의 8개 대상 중 값이 있는 지표 4개의 출처를 확인했다. NULL 지표에 출처를 임의 생성하지 않았다.
Operating Income/FCF/Gross Margin/Operating Margin의 기존 NULL을 유지했다.

## [12. O]

재처리 POST 정확히 1회, HTTP 200. 연간 FY/Period/Start 각각 10/10, 분기 각각 40/40.
기존 50행 × 8개 지표 비교: 변경 0건. 전체 provenance 291행.
최신 분기의 8개 대상 중 값이 있는 지표 4개의 출처를 확인했다. NULL 지표에 출처를 임의 생성하지 않았다.
Operating Income/FCF/Gross Margin/Operating Margin의 기존 NULL을 유지했다.

5종목 최신 회계기간:

| 종목 | 최신 연간 | 최신 분기 | 분기 시작일 | 숫자 변경 |
| --- | --- | --- | --- | --- |
| NVDA | 2026 FY · 2026-01-25 | 2027 Q2 · 2026-07-26 | 2026-04-27 | 0 |
| AAPL | 2025 FY · 2025-09-27 | 2026 Q3 · 2026-06-27 | 2026-03-29 | 0 |
| MSFT | 2026 FY · 2026-06-30 | 2026 Q4 · 2026-06-30 | 2026-04-01 | 0 |
| JPM | 2025 FY · 2025-12-31 | 2026 Q2 · 2026-06-30 | 2026-04-01 | 0 |
| O | 2025 FY · 2025-12-31 | 2026 Q2 · 2026-06-30 | 2026-04-01 | 0 |

## [13. Production Write Summary]

migration: 0016만 1회.
production Worker 배포: 1회.
SEC 재처리: NVDA → AAPL → MSFT → JPM → O, 각각 POST 1회.
해당 5종목 financial_metrics 250행의 metadata 및 source/cached timestamp와 지표 출처를 저장했다.
해당 5종목 fundamental_jobs.details에 metadataVersion=1 및 coverage 요약을 반영했다.
8개 숫자는 전체 500행의 digest 및 단일 종목 비교로 보존 확인했다.
provenance 총 2,548행이며 입력 지표도 포함하므로 250 × 8과 같아야 하는 집계가 아니다.
잘못된 source_refs JSON 0, 부모 없는 출처 0.

그 외 5종목 ABBV/ABT/AMZN/GOOGL/TSLA는 각 50행 모두 새 metadata가 NULL,
provenance 없음, metadataVersion 미설정이다.
가격·일봉·배당 테이블은 이번 재처리 경로에서 쓰지 않았다.
Business Quant/FMP 외부 호출 및 일반 global sync 실행은 하지 않았다.
기존 독립 Cron의 정상 동작은 이번 작업의 강제 실행과 구분한다.

최종 공개 회사 API 5종목 모두 HTTP 200, financials 50행, metadata 50/50.
배포 전후 NVDA/O 배당 요약·Massive 빈도·마지막 종류 객체는 완전히 같았다.
UI 파일 변경 없음. 브라우저 직접 PIN/관심목록/포트폴리오/백업 조작 검증은 미실행이며,
단위 테스트·API 호환 검증을 브라우저 검증 성공으로 대신 표기하지 않는다.

## [14. 전체 Backfill]

NO. 전 종목 loop·scheduler 강제 실행·일반 sync API 호출 없음.
허용한 5종목 검증이 끝난 지점에서 STOP했다.

## [15. 최종 Rollout Mode]

manual.
SEC 재무와 FMP 회사정보의 공통 큐 자동 갱신은 중지 상태다.
가격·일봉·독립 배당 파이프라인은 계속 정상 모드다.
정상 모드 복원은 Phase 1.6B 범위/완료 기준 검토 후 별도 사용자 승인이 필요하다.

## [16. 다음 단계 판정]

B. 운영 반영 성공했지만 [ROLLOUT MODE WARNING] 검토 필요.
Phase 1.6A 데이터 검증은 완료했고 Phase 1.6B 계획 준비는 가능하다.
전체 backfill과 normal scheduler 복원은 아직 승인·실행하지 않았다.
manual의 무기한 중지 위험을 인지하고 복원 시점에 동의한 뒤 다음 단계를 진행해야 한다.

| 최종 확인 | YES / NO |
| --- | --- |
| 1. Cloudflare redirect 호환 문제 해결 | YES |
| 2. 운영 Secret을 사용한 Cloudflare SEC 실제 200 확인 | YES |
| 3. migration 0016 정상 적용 | YES |
| 4. migration 후 기존 numeric 보존 | YES |
| 5. Worker 정상 배포 | YES |
| 6. NVDA 운영 재처리 성공 | YES |
| 7. NVDA numeric regression 0건 | YES |
| 8. AAPL/MSFT/JPM/O 검증 성공 | YES |
| 9. manual mode 영향과 복원 계획 명확 | YES |
| 10. Phase 1.6B 전체 backfill 착수 | NO · 준비 가능하지만 별도 승인 전 실행 금지 |
