# REIT Metrics R7 구현 및 검증 보고서

## R7 Verdict

**A. READY FOR CHECKPOINT**. 구현·로컬 검증·O/MSFT compact Queue rehearsal을 완료했다. Production rollout 승인은 아니다.

R6J-4에서 확정한 Architecture A만 사용했다. 기존 Free HTTP/Cron full-history CPU FAIL 판정은 유지한다.

## Starting State

- HEAD: `9a6633bd65587b71ae04e543fb6ec880d3fed14d`.
- 시작 Git: clean.
- 시작 baseline: 826 PASS / 0 FAIL / 0 SKIP, check 및 R3/R5/R6I audit PASS.
- 이번 commit/push: NO. HEAD는 동일하다.

## Architecture

- historical: 관리자 Node → 기존 CompanyFacts → R5 표준 추출기 → shared raw executor → D1 REST adapter.
- incremental: Node accession event → compact message → injectable Queue → 프로젝트 Worker queue handler → 기존 R6I indexed review/atomic store.
- full Worker path: 기존 regression/reference 코드만 유지. 신규 Queue consumer에서 호출하지 않는다.
- Production scheduler wiring: 없음. 기존 Cron과 2종목/시간 guard를 수정하지 않았다.
- Node importer/producer는 Worker bundle에 포함되지 않는다. rehearsal bundle의 esbuild input 목록에서도 확인했다.

## Historical Importer

파일: `scripts/sec-raw-historical-import.mjs`.

- single ticker / ticker list / dry-run / apply / resume / retry-failed-only 지원.
- 기본 dry-run. 명시적 apply와 활성화, DB ID/name/allowlist, 실제 metadata identity 일치 없이는 write 금지.
- R7에서 Production DB ID/name은 명시적으로 거부한다. 기본 Production target 없음.
- CLI actual write는 system CA와 Git ignored credential 파일을 요구한다. OAuth나 새 token을 만들지 않는다.
- 기존 CompanyFacts loader를 주입한다. API 재다운로드 기능 없음.
- 실제 회사 CIK가 저장돼 있으면 입력과 대조한다.
- apply 시 별도 financialPeriods 입력이 없으면 저장된 SEC financial 기간을 읽어 retention 보호에 사용한다.
- resume는 파일 cursor가 아닌 D1의 completed source identity/checkpoint에 따른다.
- 실패 종목만 재시도할 수 있고, 명시적 failed-only 실행만 backoff를 우회한다. 임대/fence는 우회하지 않는다.
- 실패해도 이전 successful accession/checkpoint와 legacy 값을 유지한다. raw/provenance/registry/checkpoint는 동일 atomic batch에 있다.
- 출력은 ticker/accession/count/status/fixed error code뿐이다. 원문·credential·email은 출력하지 않는다.

로컬 기본 실행 예:

```text
npm run raw:historical-import -- --cache-dir backups/r4/cache --ticker O
```

이는 dry-run이며 DB write를 하지 않는다. Production apply 명령은 제공하지 않는다.

## Compact Producer

파일: `scripts/sec-raw-compact-producer.mjs`, `worker/src/sec-raw-message.js`.

- schema version: 1, 명시적 validator 사용.
- envelope: ticker/accession/SEC provider/CIK/facts/financialPeriods/enqueuedAt/sourceIdentity/idempotencyKey.
- 직접기간·비교기간·같은 accession의 누적 차감 입력·instant 값·DEI 실제 날짜를 보존한다.
- 표준 지표 및 기간 anchor fact만 선택한다. 전체 CompanyFacts, label/provider response, custom/debt tag, secret은 보내지 않는다.
- 단위/날짜/form/accession/허용 tag/중복 identity/출력 record semantics를 DB 작업 전에 검증한다.
- sourceIdentity는 canonical semantic source SHA-256이며 enqueue timestamp와 Cloudflare messageId는 제외한다.
- envelope 상한은 64,000 bytes. 실제 byte 수를 hardcode하지 않는다.
- 실제 O envelope 8,508 bytes, MSFT 6,146 bytes. version/source identity 등의 metadata를 포함한 수치다.
- `enqueueCompactSecRaw`는 injectable Queue, 기본 disabled/dry-run.
- `onSecRawAccessionDetected`는 향후 Node discovery/event 연결 지점이다. Production Cron에는 연결하지 않았다.
- enqueue 성공 상태는 queued이고 raw ready가 아니다.

## Queue Consumer

파일: `worker/src/sec-raw-queue.js`, `worker/src/index.js`의 queue handler.

- validate → shared R6I executor → lease/fence → indexed review → atomic raw/provenance/checkpoint → ack/retry.
- 기존 추출/정정 판단/저장 로직을 consumer에 복사하지 않았다.
- invalid JSON/schema/version/accession/unit/identity: DB 호출 0, rejected/ack.
- 일시적 D1 오류·lease contention: retry, 900초 backoff. 이전 successful checkpoint 보존.
- NULL→available, available 정정, entity scope conflict, 기존 needs_review: pending_review/ack. ready 자동 승격 금지.
- 동일 messageId 및 다른 messageId의 동일 semantic payload를 모두 처리한다.
- 같은 accession이라도 source identity가 바뀌면 완료 shortcut을 사용하지 않고 비교/검토한다.
- 기존 SQL의 full-key indexed lookup을 유지했다. ticker 전체 scan으로 되돌리지 않았다.

## Migration

- needed: YES.
- migration number: `0022_sec_raw_payload_checkpoint.sql`.
- additive-only: YES. 새 `sec_raw_payload_checkpoint` 테이블만 추가한다.
- 이유: 기존 0021에는 completed accession만 있어 같은 accession의 changed payload를 구분할 저장 identity가 없다.
- historical/compact channel, accession, schema version, source identity를 완료 상태로 별도 보존한다.
- 검토가 필요한 실행은 완료 checkpoint를 갱신하지 않는다.
- 기존 0001~0021 수정: 0. 기존 table DROP/rename/column 의미 변경: 없음.
- 로컬 Fresh / Existing 0021→0022 검증: PASS.
- disposable rehearsal에는 0022의 CREATE TABLE DDL만 실행했다. `d1_migrations` ledger를 수정하지 않았다.
- Production applied: NO.

## Feature Flags

- `SEC_STANDARD_RAW_FIELDS_ENABLED`: 기본 false 유지.
- `SEC_STANDARD_RAW_QUEUE_ENABLED`: 기본 false. fields와 queue 모두 문자열 true일 때만 consumer 처리.
- `SEC_STANDARD_RAW_HISTORICAL_IMPORT_ENABLED`: 기본 false. Node CLI의 명시적 `--enable-historical-import`도 지원.
- Production flag/Secret/wrangler 설정 변경: 없음.
- 실제 Queue consumer 연결/binding 생성: Production에서는 없음.
- rehearsal harness에서만 명시적으로 활성화했다.

## Local Tests

- npm test: **873 PASS / 0 FAIL / 0 SKIP**.
- 기존 tests: 826 유지. 신규 R7 tests: 47.
- npm run check: PASS.
- r3:check / r3:audit: PASS.
- r5:check / r5:audit: PASS.
- r6i:check / r6i:audit: PASS.
- r7:check / r7:audit: PASS.
- git diff --check / cached --check: PASS.
- 검증 요약/로그는 Git ignored `backups/r7/local-gates.json` 및 관련 log에 저장했다.

필수 failure tests는 invalid JSON/version/ticker/accession, mixed accession, duplicate identity, D1 중간 쓰기/provenance/checkpoint/registry 실패, lease owner/fence 상실, temporary D1 오류, 정정/NULL 해소/review를 포함한다. partial semantic corruption은 0이다.

## Historical Equality

기존 R4 cache의 source SHA-256 10개를 대조했다. 새 SEC/BQ/FMP/Massive 호출은 각각 0회다.
R5 추출 결과를 기존 store에 직접 적재한 reference와 전체 raw/provenance 의미 컬럼을 대조했다.

| 종목 | raw | available / provenance | missing | needs_review |
| --- | ---: | ---: | ---: | ---: |
| NVDA | 974 | 404 | 570 | 0 |
| AAPL | 977 | 443 | 534 | 0 |
| MSFT | 969 | 405 | 564 | 0 |
| JPM | 769 | 356 | 413 | 0 |
| O | 953 | 709 | 238 | 6 |
| ABBV | 983 | 493 | 490 | 0 |
| ABT | 780 | 437 | 338 | 5 |
| AMZN | 969 | 484 | 485 | 0 |
| GOOGL | 714 | 308 | 406 | 0 |
| TSLA | 974 | 576 | 384 | 14 |
| 합계 | 9,062 | 4,615 | 4,422 | 25 |

- retention: 285/285 복구 유지.
- DEI: 실제 날짜/source provenance 동일. period-end로 변환하지 않았다.
- financial: 기존 500행 numeric/all-column 불변.
- classification / financial provenance / flow: 기존 R5 regression PASS.
- Run2: raw/provenance semantic change 0, 불필요한 raw/provenance write 0.
- 초기 full 입력의 needs_review 25건은 유지한다. O/ABT/TSLA의 historical registry를 ready로 자동 승격하지 않는다.
- EBIT/EBITDA strict optional/sparse 유지. 신규 Total Debt/Net Debt/EV/EV-EBITDA/REIT 회사별 지표 없음.

## O Compact

- raw 67 / available 44 / missing 23, 기존 R6I candidate deep equality PASS.
- remote result: ready / outcome ok / exception 없음.
- actual Cloudflare CPU: 37ms. wall: 2,425ms.
- D1 binding calls 8 / SQL statements 13 / rows_read 838 / rows_written 339.
- 3행 historical seed 보존. 저장 후 raw 69 / provenance 47. duplicate/orphan 0.

## MSFT Compact

- raw 49 / available 21 / missing 28, 기존 R6I candidate deep equality PASS.
- remote result: ready / outcome ok / exception 없음.
- actual Cloudflare CPU: 17ms. wall: 1,897ms.
- D1 binding calls 8 / SQL statements 13 / rows_read 650 / rows_written 216.
- 3행 historical seed 보존. 저장 후 raw 51 / provenance 24. duplicate/orphan 0.

CPU는 로컬 elapsed가 아닌 실제 Queue invocation 값이다. 각 1회만 측정했으며 p95 연구/추가 반복은 하지 않았다. metadata checkpoint 추가로 이전 R6J-4와 호출/쓰기 수가 같다고 주장하지 않는다. Queue budget 기준 PASS이고 기존 HTTP/Cron 10ms FAIL은 그대로다.

## Redelivery / Idempotency

이번 remote test는 **다른 messageId로 동일 semantic payload를 각 1회** 보낸 idempotency 검증이다. 동일 messageId의 실제 retry를 R7 remote에서 다시 측정한 것으로 보고하지 않는다. 동일 messageId 처리와 changed payload/new accession/정정/review는 R7 로컬 tests 및 기존 R6J-4 실제 재전달 증거로 구분한다.

| 종목 | remote duplicate CPU | D1 calls / SQL | rows_read | rows_written | semantic change |
| --- | ---: | --- | ---: | ---: | ---: |
| O | 13ms | 6 / 6 | 318 | 0 | 0 |
| MSFT | 8ms | 6 / 6 | 278 | 0 | 0 |

## Regression

- GENERAL NVDA/AAPL/MSFT/TSLA: 기존 financial/UI tests PASS, UI 파일 변경 없음.
- BANK JPM: REIT UI 미노출 tests 유지.
- REIT O: FFO/NFFO/AFFO total/per-share, annual/quarterly, definition boundary, tooltip/summary tests 유지.
- O specialized: definitions 14 / values 950 / provenance 1,344.
- combined digest: `4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5` 불변.
- 실제 remote rehearsal 보호 테이블 40개의 count/digest 전후 동일. 이는 Production DB를 새로 조회한 검증은 아니다.
- UI/public HTTP/scheduler behavior는 기존 코드/회귀 tests를 근거로 유지. 이번 Phase에서 운영 브라우저 화면/Network를 재관측하지 않았다.

## Rehearsal

- Worker: `us-stock-rehearsal-gate`.
- Queue: `us-stock-rehearsal-queue`.
- D1: `us-stock-dashboard-p75-rehearsal-20261001`.
- binding: `REHEARSAL_DB`만 사용.
- Queue batch 1 / concurrency 1 / retries 1, Cron 0, workers.dev OFF 확인.
- actual project `index.js.queue()` handler를 harness에서 호출했다. Worker에는 전체 CompanyFacts를 보내지 않았다.
- 날짜/사용량 새 조회: 2026-10-04 17:28:32.632 UTC, reads 827,848 / writes 5,708 / headroom 94,292.
- test 5,000 + production reserve 5,000 gate: PASS.
- 실제 write: setup 46 + processing 558 + cleanup 197 = **801**. processing에는 disposable checkpoint table DDL write 3이 포함된다.
- cleanup: R7 test alias/data 0건. 기존 데이터/Queue/Worker/D1/credential 파일 보존.
- rehearsal Worker 최종 버전: 기존 probe `6dde80e1-b0ba-4d03-a8f6-da2fc88ca8b9` 복구.
- 새 checkpoint 테이블은 disposable D1에 빈 상태로 보존했다. 기존 보호 자료는 변경하지 않았다.
- remote 결과는 Git ignored `backups/r7/remote-results.json`에 저장했다.
- Node historical importer의 실제 D1 REST write는 이 Phase의 remote 범위가 아니며 추가 실행하지 않았다. historical actual write/rollback/resume는 disposable 로컬 SQLite adapter에서 검증했다.

## Secret Scan

- candidate 파일 및 staged diff 검사: 민감정보 발견 0.
- staged 파일: 0. Git index에 파일을 추가하지 않았다.
- 로컬 credential 실제 값과 email 패턴을 candidate 내용과 대조했다. 값/길이/hash는 출력하지 않았다.
- `.dev.vars.rehearsal` 등 환경파일/CompanyFacts/PDF/SQLite/cache/임시 결과의 commit 대상 포함: 0.
- 모든 secret/cache/remote log/생성 harness는 ignored 경로에만 있다.

## Changed Files

1. `worker/migrations/0022_sec_raw_payload_checkpoint.sql`
2. `worker/src/sec-standard-raw-incremental.js`
3. `worker/src/sec-standard-raw-store.js`
4. `worker/src/sec-raw-message.js`
5. `worker/src/sec-raw-queue.js`
6. `worker/src/index.js`
7. `scripts/sec-raw-historical-import.mjs`
8. `scripts/sec-raw-compact-producer.mjs`
9. `scripts/sec-raw-architecture-audit.mjs`
10. `tests/sec-raw-architecture.test.js`
11. `package.json`
12. `docs/reit-metrics-r7-report.md`

기존 convention과 검증된 JS/ESM 모듈을 재사용했다. 이 Phase에 React/TypeScript 전환이나 새 build dependency를 도입하지 않았다.

## Production

ALL NO: migration apply / DB write / historical backfill / Worker deploy / Pages deploy / flag ON / Cron 변경 / Secret 변경 / Queue 생성 / push.
Production metadata를 독립 재관측한 PASS로 주장하지 않는다. 실행한 변경 API와 DB 쓰기는 명시적으로 rehearsal 범위에만 제한했다.

## Git

- commit: NO.
- push: NO.
- HEAD: 시작 checkpoint 그대로.
- status: R7 관련 12개 파일만 미커밋 변경. clean이라고 보고하지 않는다.
- 기존 migration/UI/scheduler/production config 및 unrelated 파일 변경: 0.

## Next Step

별도 승인 후 R7 checkpoint commit. 그 다음 Production promotion 검토가 필요하다. 이번 작업은 구현·검증 완료 상태에서 중단한다.

마지막 YES/NO:

1. Node historical importer 구현: YES.
2. Worker full-history 제거 방향 유지: YES.
3. compact producer 구현: YES.
4. Queue consumer 구현: YES.
5. same/new message idempotency: YES.
6. correction/review 정책 유지: YES.
7. O/MSFT semantic equality: YES.
8. rehearsal remote PASS: YES.
9. 기존 financial/O specialized 불변: YES.
10. Production 변경 0: YES.
11. Secret 포함 0: YES.
12. READY FOR CHECKPOINT: YES.
