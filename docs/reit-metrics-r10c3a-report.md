# R10C-3A — Production Producer Runner Wiring

## 판정과 실행 범위

기준 checkpoint: `b869a6845bcca866c58a88d2e32e14e4710eefb8`.

최종 판정은 **A. PRODUCTION RUNNER READY FOR CHECKPOINT**다. 이는 로컬 코드/계약 검증 판정이며 실제 credential scope, state repo provisioning 또는 운영 자동화 활성화 승인이 아니다.

외부 호출은 전부 fake로 대체했다. 실제 GitHub/Cloudflare/SEC request, Queue publish, Production D1 read/write, 배포, Secret/token 생성, workflow/scheduler 생성은 0이다. commit/push/stage도 실행하지 않는다.

## Queue 계약

- endpoint: `POST /accounts/{account_id}/queues/{queue_id}/messages` 유지.
- 기존: `{ messages: [{ body: message, content_type: "json" }] }`.
- 변경: `{ body: message, content_type: "json" }`.
- `/messages/batch`와 `delay_seconds`를 사용하지 않는다.
- 2xx + `success=true`만 ACCEPTED. messageId를 가정하거나 만들어내지 않는다.
- 400/401/403/404/429는 deterministic rejection. 401/403/404는 전체 run 중단.
- 429는 재발행하지 않고 FAILED_SAFE/operator 판단으로 넘긴다. provider retry 0의 보수적 bounded policy다.
- 5xx/timeout/reset/손상 성공 응답은 수락 여부가 미확정이므로 AMBIGUOUS. 성공·실패를 추정하지 않으며 즉시 재발행하지 않는다.

## 실제 runner 연결

entrypoint: `scripts/sec-raw-production-runner.mjs`.

`npm run raw:production`은 기본 detect-only. `--enqueue`를 명시하고 policy 승인, release/target/time/schema/scope, durable journal, D1 readiness, 전용 credential, payload/예산/INTENT 검증을 모두 통과해야 발행한다. 이번 Phase에서는 이 live CLI를 실행하지 않았다.

환경 변수 → strict policy → disconnected verifier → D1 identity/readiness → GitHub backend load → 기존 scheduled core → 전용 SEC fetch/단건 Queue transport → 허용된 summary 순서다.

D1 mismatch 시 journal/SEC/Queue 작업 이전에 중단한다. D1 metadata는 한 번, run readiness SELECT는 한 번만 실제 adapter에서 요청하며 core에는 같은 결과를 전달한다. ticker당 indexed SELECT는 3개다.

detect-only는 remote journal snapshot을 읽되 lock/reconcile/defer를 메모리 shadow에서만 수행한다. GitHub remote write와 Queue publish는 0이다. shadow는 enqueue의 durable backend로 사용하지 않는다.

기존 core/identity/journal/consumer/SQL schema/UI는 변경하지 않는다. pending runtime과 같은 source/accession/schema의 compact checkpoint가 함께 확인될 때만 REVIEW_BLOCKED 증거를 연결한다. pending이라는 문자열만으로 완료/review를 추정하지 않는다.

## Credential/env 계약

전용 Secrets:

- `CF_QUEUE_API_TOKEN`: Queue 전송만.
- `CF_D1_READ_API_TOKEN`: D1 metadata/SELECT만.
- `PRODUCER_STATE_TOKEN`: 전용 private state repo Contents만.
- `SEC_USER_AGENT`: SEC 연락처만.

세 token이 같은 문자열이면 거부한다. `.dev.vars`, 범용 Cloudflare token, Wrangler OAuth, Observability token, backup GitHub credential을 탐색/읽기/병합하지 않는다. 실제 서버 권한은 후속 provisioning gate에서 확인해야 하며 로컬 wiring 검증만으로 scope를 PASS 처리하지 않는다.

필수 Variables:

`CF_ACCOUNT_ID`, `CF_QUEUE_ID`, `CF_QUEUE_NAME`, `CF_D1_DATABASE_ID`, `CF_D1_DATABASE_NAME`, `PRODUCER_STATE_REPOSITORY`, `PRODUCER_STATE_BRANCH`, `PRODUCER_STATE_PATH`, `PRODUCER_POLICY_PATH`.

`PRODUCER_RELEASE`를 제공하면 Git HEAD와 같아야 한다. CLI는 HEAD를 직접 확인한다. state repo/branch/path는 필수이며 위험한 default/fallback을 사용하지 않는다. checkpoint backup 이름의 repo를 거부한다.

CLI의 추가 필수 variable: `PRODUCER_DISCONNECT_EVIDENCE_PATH`.

dependency-injected `verifyDisconnected` 또는 이 경로의 pre-issued evidence를 소비한다. evidence는 version/release/repository/stateBranch/statePath/validFrom/expiresAt/workflows/webhooks/deployments/cloudflareConnections exact 필드이며 연결 count가 전부 0, 유효기간 내, 최대 7일이어야 한다. 실제 연결 차단 inventory를 이번 Phase에서 수행하거나 evidence를 발급하지 않았다. true hardcode/default 승인 없음. 증거의 신뢰할 수 있는 발급·배포는 후속 gate의 책임이다.

## Policy

policy 경로가 없거나 파일이 손상되면 중단한다. 파일은 최대 1MiB. identityAlgorithmVersion=2를 명시해야 하고 schemaVersion=1, 현재 HEAD, env와 account/database/queue의 ID/name exact, 해시/시간/승인 scope를 모두 검증한다. LMT는 거부한다. ticker list는 policy.scope에서만 읽는다.

## D1 읽기 경계

`scripts/sec-raw-production-d1.mjs`: GET metadata + POST query만 제공한다. metadata UUID/name과 요청 account를 exact 검증한다. identity에는 accountId/databaseId/databaseName과 기존 reader의 uuid/name 별칭을 함께 제공한다.

SELECT strict guard: write keyword, PRAGMA, 주석, 복문, extension, 비허용 table, whole raw/provenance scan을 차단한다. companies/checkpoint/runtime/financial_metrics/d1_migrations만 허용한다. 사업 table은 WHERE/bind가 필요하다. run/batch/write 메서드 없음. query 수 상한은 `1 + 3 × scopeCount` (최대 301), 응답 row/byte 상한과 timeout 적용. 실패 시 재시도 및 raw 오류 출력 없음.

## GitHub provisioning/CAS

`createGithubJournalBackend`를 전용 env에 연결했다. private/full_name exact/non-default branch/path/disconnect verifier가 모두 필요하다.

`scripts/sec-raw-state-provisioning.mjs`는 default branch bootstrap, state branch 생성, 빈 journal 초기화 계약과 후속 CAS harness를 제공한다. injectable fetch만 있으며 실행 CLI/default network는 없다. bootstrap은 기존 state를 덮어쓰지 않는다.

cleanup은 provisioning helper에만 있다. 명시적 `state/synthetic-*.json` + SYNTHETIC-only state + SHA를 검증하고 삭제한다. production journal 경로나 실제 ticker 혼입 state 삭제 금지. 404 재확인으로 residue 0을 확인한다.

CAS harness: read missing → synthetic INTENT 생성 → exact read → ACCEPTED update → stale SHA conflict → current SHA update → exact read → synthetic cleanup → residue 0. 409/422는 bounded CAS retry 3회이며 network ambiguity는 retry하지 않는다. 실제 remote 실행 없음.

## 테스트/확장성

시작: 기존 1,127 PASS / 0 FAIL / 0 SKIP 및 npm/check/R10B/R10C2 검증 PASS.

신규 테스트는 exact Queue 계약, 응답 의미, no-retry, env/policy/credential boundaries, 실제 runner의 fake end-to-end, 10종목 unchanged/AAPL compatibility, pending review, detect-only shadow, 100 ticker, synthetic bootstrap/CAS/cleanup, D1 SQL/identity/quota/sanitization을 포함한다.

100 ticker unchanged: readiness SELECT 1 + ticker SELECT 300 = 301, GitHub GET 3, SEC fake read 200, Queue 0, GitHub write 0. 별도 100 ticker enqueue 예산 1 테스트는 발행 1, budgetSkipped 99, INTENT 1이다. 실제 외부 요청은 모두 0.

summary는 runId/release/policyHash/mode/scope/count/error category만 포함한다. publishCount는 성공 건수가 아니라 실제 transport 시도 수다. Secret/연락처/header/raw/financial/provider body/messageId를 출력하지 않는다.

최종: 기존 1,127 + 신규 73 = **1,200 PASS / 0 FAIL / 0 SKIP**.

- `npm run check`: PASS.
- `r10b:check` / `r10b:audit`: PASS.
- `r10c2:check` / `r10c2:audit`: PASS.
- `r10c3a:check` / `r10c3a:audit`: PASS.
- `git diff --check`: PASS. 신규 파일의 whitespace도 별도 검사 PASS.
- `r5:audit`: 기존 실제 10종목 cache hash 10/10, retention 285/285, financial 500행/classification/provenance 불변 PASS.
- `r7:audit`: 9,062 / 4,615 / 4,422 / 25 exact, Run2 raw/provenance write 0, compact/idempotency PASS.
- `r8i-fix:audit`: 기존 P75 artifact를 메모리 disposable DB에 재사용하여 O specialized 14 / 950 / 1,344 및 combined digest `4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5` 불변 PASS. duplicate/orphan 0.

R5 audit의 선택적 외부 PDF cache 재파싱은 인자 없이 실행하여 NOT VERIFIED이며, 전문 지표 전체 수치/digest의 새 검증 근거는 별도 R8I-FIX audit다. 새 다운로드나 raw/PDF 복제는 없다.

실제 Cloudflare CPU/권한/원격 quota는 이번 로컬 Phase에서 NOT VERIFIED다. bounded query 개수를 실제 quota 검증으로 대체하지 않는다.

## 변경 파일과 금지 영역

신규: production HTTP/D1/runner/provisioning/check/audit, production fake helper, runner/단건 transport 테스트, 본 보고서.

수정: Queue transport body, 기존 transport contract assertion, package.json 명령, 기존 R10B/R10C2 check allowlist의 승인된 R10C-3A 파일 확장. 기존 검증을 우회하지 않으며 별도 check가 기준 HEAD와 protected source/migration 22개를 재검증한다.

신규 migration 없음. CompanyFacts cache/PDF/SQLite/환경파일/실제 Secret/연락처/Production evidence는 candidate에 포함하지 않는다. R10C2 audit가 기존 ignored cache를 읽어 compatibility를 검증할 뿐 repo로 복제하지 않는다.

정확한 candidate 15개:

1. `scripts/sec-raw-production-http.mjs`
2. `scripts/sec-raw-production-d1.mjs`
3. `scripts/sec-raw-production-runner.mjs`
4. `scripts/sec-raw-state-provisioning.mjs`
5. `scripts/sec-raw-production-check.mjs`
6. `scripts/sec-raw-production-audit.mjs`
7. `tests/helpers/sec-raw-production-fixtures.js`
8. `tests/sec-raw-production-runner.test.js`
9. `tests/sec-raw-single-transport.test.js`
10. `scripts/sec-raw-automation-transport.mjs`
11. `tests/sec-raw-scheduled-producer.test.js`
12. `scripts/sec-raw-automation-check.mjs`
13. `scripts/sec-raw-identity-check.mjs`
14. `package.json`
15. `docs/reit-metrics-r10c3a-report.md`

Git: 기준 HEAD 유지, 승인된 미커밋 변경만 존재, staged 0, commit NO, push NO. 따라서 의도적으로 clean은 아니며 controlled changes only다.

## 남은 단계

로컬 checkpoint 승인 후 별도 authenticated private state provisioning + 실제 CAS/cleanup/disconnected 검증, 최소 권한 credential 준비, 최신 policy/evidence 발급, 제한된 운영 detect-only gate가 필요하다. workflow/scheduler/enqueue를 자동 진행하지 않는다.

## 마지막 YES/NO

1. Queue single-message contract fixed? YES
2. batch wrapper 제거? YES
3. production runner 구현? YES
4. detect-only default? YES
5. explicit enqueue required? YES
6. GitHub state backend wired? YES
7. D1 read-only adapter wired? YES
8. D1 writes impossible? YES — adapter capability/SQL guard 기준.
9. Queue/D1/GitHub credential separated? YES
10. Observability credential reuse 0? YES
11. Wrangler OAuth reuse 0? YES
12. policy/env target validation? YES
13. INTENT-before-send 유지? YES
14. ambiguous immediate retry 0? YES
15. accepted suppression 유지? YES
16. review suppression 유지? YES
17. 100 ticker bounded? YES
18. migration 0? YES
19. all tests PASS? YES
20. network request 0? YES — 실제 외부 요청 기준.
21. Production 변경 0? YES
22. Git controlled changes only? YES
23. PRODUCTION RUNNER READY FOR CHECKPOINT? YES — 로컬 checkpoint 준비 판정에 한정.
