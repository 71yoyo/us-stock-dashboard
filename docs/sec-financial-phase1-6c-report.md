# Phase 1.6C 운영 복원 보고서

검증일: 2026-09-30. 판정: **A — 정상 복원 완료, SEC metadata rollout 종료, UI Phase 2 진행 가능.**

## [1. 작업 전 상태]

- `main`의 기존 미커밋 작업을 보존했다. 시작 시 추적 변경은 `package.json`, `worker/src/fmp-sync.js`, `worker/src/fundamental-sync.js`, `worker/src/index.js`, `worker/wrangler.jsonc`였다. 이전 Phase 보고서·검증 도구·테스트·migration 0016 등 미추적 파일도 보존했다. commit/push/reset/삭제는 하지 않았다.
- `npm test`: 114 PASS / 0 FAIL. `npm run check`, `git diff --check`: 통과.
- Cloudflare 운영 `/settings` 읽기 결과: `SEC_FINANCIAL_ROLLOUT_MODE=manual`.
- `fundamental_jobs`: financials 10개·profile 10개 모두 `ready`, error 없음, lease 없음. 기록된 마지막 확인 시각은 financials 9월 29일, profile 9월 22일이었다. 작업 실행 이력이 아니라 기존 정상 저장 이력이다.
- `financial_metrics`: 500행. 세 metadata 필드 각각 500/500, financial jobs 10종목 모두 `metadataVersion=1`.
- provenance: 5,223행. orphan 0, invalid JSON 0.
- 아래 numeric digest가 기대값과 동일하므로 진행했다.

```text
5590e9f97020ef87c310fa964fafec9519ff9967b40cf00317917fbd84c0acaf
```

## [2. Manual Mode 기존 영향]

`runFundamentalBatch()`의 manual early return이 공통 큐를 중단한다. SEC financial sync와 FMP company profile sync가 이에 해당하며 scheduled 경로도 같은 함수를 사용한다.

가격, Massive 일봉, 독립 `runDividendPipeline()`은 이 manual 조건 밖에 있다. fundamental Cron에서도 배당은 별도 `waitUntil()`로 호출한다. 따라서 manual 해제가 가격·배당 수집 방식을 바꾸지는 않는다.

## [3. Normal 복원 방식]

`worker/wrangler.jsonc`의 설정을 명시적 `normal`로 변경했다. 기존 코드가 중지하는 값은 정확히 `manual`뿐이며, `normal` 및 미설정은 활성 상태다. `--keep-vars` 배포에서도 정상 모드 의도를 명시하기 위해 제거 대신 `normal`을 선택했다.

manual safety branch는 유지했다. 공통 `fundamentalQueueRuntimeStatus()`를 추가하여 실제 큐와 health 진단이 같은 조건을 사용하도록 했다. `/api/health`의 추가 필드는 환경값만 읽으며 DB 접근·외부 API 호출·수집을 유발하지 않는다.

이번 단계 변경 파일:

- `worker/wrangler.jsonc`: normal 설정
- `worker/src/fundamental-sync.js`: 공통 운영 상태 진단 함수
- `worker/src/index.js`: 기존 health 응답에 `fundamentalQueue` 추가
- `tests/sec-financial-phase1-6c.test.js`: 쓰기 없는 제어 경로·health 검증 3개
- `scripts/sec-financial-scheduler-observe.mjs`: 자연 실행 로그 읽기 전용 관찰 도구
- 이 보고서

## [4. Worker Deploy]

- 결과: 성공
- Worker: `us-stock-dashboard-api`
- version: `a7f2fb18-3976-4f84-9459-b752426d5864`
- 운영 배포 시각: 2026-09-30 03:18 UTC / 12:18 한국시간
- 명령: `node --use-system-ca node_modules/wrangler/bin/wrangler.js deploy --config worker/wrangler.jsonc --keep-vars`
- migration 실행 없음, Secret 변경 없음. 기존 5개 Cron과 D1 binding 유지.

## [5. Production Runtime Mode]

- manual: **NO**
- fundamental queue: **ACTIVE**
- Cloudflare 운영 설정 조회: `normal`
- 실제 배포된 `/api/health`: `fundamentalQueue={rolloutMode:"normal",status:"ACTIVE"}`

로컬 설정만으로 판단하지 않았다. ACTIVE는 manual 중단 조건이 해제됐다는 의미다. 앞으로 실행되는 모든 외부 API 요청의 성공을 보장하는 표현은 아니다.

## [6. Scheduler]

Cloudflare `/schedules`에서 배포 전후 동일한 5개 Cron을 확인했다. 모두 UTC 기준이다.

| Cron | 기존 경로 |
| --- | --- |
| `1-59/5 * * * *` | fundamental queue + 독립 Business Quant 배당 |
| `20 21 * * 1-5` | 가격 수집 |
| `*/5 0-6 * * 2-6` | Massive 장 마감 후 일봉 |
| `*/5 13-20 * * 1-5` | 가격 또는 장 마감 완료 시 Massive 일봉 |
| `*/5 21-23 * * 1-5` | Massive 장 마감 후 일봉 |

fundamental 경로는 `scheduled()` → `executionContext.waitUntil(runFundamentalBatch(environment))`이며 normal 상태에서 실행 가능하다. 분 단위 예정은 매시 1·6·11·16·21·26·31·36·41·46·51·56분이다.

Wrangler tail로 자연 실행만 관찰했다. `1-59/5 * * * *`의 이벤트 시각은 03:21:39 UTC / 12:21:39 한국시간, `outcome=ok`, 예외 0건이었다. Massive Cron `*/5 0-6 * * 2-6`도 03:20:39 UTC에 `ok`, 예외 0건으로 관찰됐다. 요청 본문·헤더·토큰·예외 메시지는 출력하지 않았다.

03:25:49 UTC 확인 시 다음 fundamental Cron 예정 분은 03:26 UTC / 12:26 한국시간이다. 실제 전달 시각은 예정 분보다 늦을 수 있다.

당시 financial/profile 작업은 모두 미래 `next_run_at`이어서 관찰한 Cron이 10종목 SEC 재수집을 수행했다고 주장하지 않는다. 가장 빠른 financial 작업은 NVDA의 04:51:49 UTC로, 기존 분 단위 일정상 04:56 UTC / 13:56 한국시간부터 처리 대상이다. 강제 실행하거나 예정 시각을 당기지 않았다.

## [7. API Smoke Test]

운영 API `https://us-stock-dashboard-api.771yoyo.workers.dev`에서 확인했다.

| 경로 | HTTP | 확인 |
| --- | --- | --- |
| `/api/health` | 200 | normal / ACTIVE, 기존 설정 필드 유지 |
| `/api/companies` | 200 | 10종목 |
| `/api/companies/NVDA` | 200 | financials 50행, metadata 50행 채움 |
| `/api/companies/O` | 200 | financials 50행, metadata 50행 채움 |

`fiscalYear`, `fiscalPeriod`, `periodStart` 및 기존 가격·변동률·일봉·기술지표·배당 요약·Massive 빈도/종류 응답 필드를 유지했다. UI 파일은 수정하지 않았다. 이번 단계에서 브라우저 PIN/포트폴리오 조작을 새로 수행했다고 주장하지 않는다.

## [8. Numeric Regression]

시작 전, 배포 직전, 배포 직후, 자연 Cron 관찰 후 다시 읽기 전용으로 비교했다.

```text
작업 전: 5590e9f97020ef87c310fa964fafec9519ff9967b40cf00317917fbd84c0acaf
작업 후: 5590e9f97020ef87c310fa964fafec9519ff9967b40cf00317917fbd84c0acaf
```

- 500행 × 8개 기존 재무값, 총 4,000개 변경: **0건**
- 전체 digest 동일, 각 10종목의 50행 digest도 동일
- 비교 항목: revenue, operating_income, net_income, eps, free_cash_flow, roe, gross_margin, operating_margin
- numeric selection, EPS/FCF/ROE 정의를 변경하지 않았다.

## [9. Metadata]

| 항목 | 결과 |
| --- | --- |
| financial_metrics | 500행 |
| fiscal_year | 500/500 |
| fiscal_period | 500/500 |
| period_start | 500/500 |
| metadataVersion | 10종목 모두 1 |
| 종목별 이력 | 각 연간 10행 + 분기 40행 |

자연 Cron 관찰 후에도 동일하다. migration 0016 파일과 DB schema는 수정하지 않았다.

## [10. Provenance Integrity]

| 항목 | 전후 결과 |
| --- | --- |
| 총 행 수 | 5,223 → 5,223 |
| orphan | 0 |
| invalid source_refs_json | 0 |

종목별 행 수도 유지됐다: NVDA 618, AAPL 645, MSFT 604, JPM 390, O 291, ABBV 536, ABT 524, AMZN 493, GOOGL 490, TSLA 632. 검증 SELECT들의 `rows_written=0`을 확인했다.

## [11. Pipeline 상태]

| Pipeline | 상태 | 검증 범위 |
| --- | --- | --- |
| SEC financial | ACTIVE | runtime gate 해제, jobs 10개 ready/error 없음 |
| FMP company profile | ACTIVE | 동일 공통 큐 복원, jobs 10개 ready/error 없음 |
| Price | ACTIVE / 영향 없음 | 기존 경로·Cron·설정 보존 |
| Massive daily | ACTIVE / 영향 없음 | 기존 경로 보존, 자연 Cron ok 관찰 |
| Business Quant dividend | ACTIVE / 영향 없음 | 독립 경로·활성 설정·한도 24 유지 |

Business Quant/FMP 확인용 외부 API 호출은 추가하지 않았다. 이번 단계는 큐 복원 검증이므로 공급원별 신규 데이터 수집 성공 검증과 구분한다. 자연 실행 이후 financial/profile 20개 작업 모두 ready, error 0건을 확인했다.

## [12. Test]

- 작업 전: 114 PASS / 0 FAIL
- 최종: **117 PASS / 0 FAIL**, 기존 테스트 삭제·완화 없음
- `npm run check`: 통과
- 관찰 스크립트 `node --check`: 통과
- `git diff --check`: 통과. Git의 LF→CRLF 안내는 오류가 아니다.

추가 3개 테스트는 manual/normal 판별, normal 제어 경로의 early return 통과, health의 DB·외부 호출 없는 진단을 검증한다. DB 첫 접근에서 차단하는 mock을 사용하여 실제 저장·수집을 유발하지 않았다.

## [13. Production Write]

| 항목 | 수행 여부 |
| --- | --- |
| migration 생성/수정/실행 | NO |
| DB backfill | NO |
| 10종목 강제 재처리 | NO |
| forced global sync | NO |
| Secret 변경 | NO |
| Worker deploy | YES — 1회 |
| UI 변경/정적 홈페이지 배포 | NO |

원격 DB 검증은 SELECT만 사용했다. 자연 scheduler의 기존 큐 관리/독립 수집까지 전부 쓰기 0건이었다고 주장하는 것은 아니다. 이번 작업이 강제한 DB 적재는 없으며, 재무 숫자·metadata·provenance는 관찰 전후 그대로다.

## [14. 최종 판정]

**A. Phase 1.6C 정상 복원 완료. SEC metadata rollout 종료. UI Phase 2 진행 가능.**

현재 준비된 것은 Phase 2를 시작할 수 있는 데이터/큐 상태다. UI Phase 2를 구현한 것은 아니다. 미래에 정상 스케줄로 도래하는 작업의 외부 API 오류는 기존 재시도·마지막 정상 데이터 보존 정책으로 처리한다.

| 최종 확인 | YES/NO |
| --- | --- |
| 1. manual mode 정상 해제 | YES |
| 2. SEC financial queue 활성화 | YES |
| 3. FMP company profile queue 활성화 | YES |
| 4. 가격/Massive/배당 pipeline 영향 없음 | YES |
| 5. 기존 numeric digest 동일 | YES |
| 6. metadata 500/500 유지 | YES |
| 7. provenance integrity 유지 | YES |
| 8. 공개 API 정상 | YES |
| 9. 전체 테스트 통과 | YES |
| 10. Phase 1 종료 및 UI Phase 2 진행 가능 | YES |
