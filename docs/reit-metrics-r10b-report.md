# R10B — Incremental Producer Core 로컬 구현 보고서

## R10B Verdict

**A. PRODUCER CORE READY FOR CHECKPOINT**

이는 로컬 core의 checkpoint 준비 판정이다. 운영 자동화 실행·실제 SEC 수집·발행·배포 승인을 뜻하지 않는다.

- 기준 HEAD: `9fbf7a5deeb67fda8e94aab9d3f28d8fcc7582c6`.
- 시작 Git clean, 기존 테스트 982 PASS / 0 FAIL / 0 SKIP 확인.
- 최종: 기존 982 + 신규 117 = **1,099 PASS / 0 FAIL / 0 SKIP**.
- 운영/외부 요청 0, 실제 credential 사용 0, commit/push 0.

## Architecture

Node core에서만 다음 순서로 실행한다. 기존 Worker HTTP/Cron/consumer/historical importer에 연결하지 않았다.

`strict policy → journal run lock → run readiness → ticker별 SEC source → oldest candidate → compact build/validation → dedupe → durable INTENT → 단일 Queue POST → journal 결과`

전송 수락은 DB 완료가 아니다. 이후 exact checkpoint 또는 source를 특정한 review 증거가 journal을 reconcile한다.
불명확한 전송은 재발행하지 않고 운영 확인으로 넘긴다.

## Node SEC Fetch

파일: `scripts/sec-raw-source-fetch.mjs`.

- CompanyFacts/Submissions의 공식 URL을 구성하는 live-capable Node loader 구현.
- 명시적인 `SEC_USER_AGENT` 입력 필수. 이번에는 합성 문자열만 사용했다.
- 승인 ticker/CIK 형식, 응답 CIK, Submissions ticker/parallel arrays, JSON/content type 검증.
- streaming response 상한 기본 32 MiB. Content-Length와 실제 누적 bytes 모두 검사.
- AbortController 기반 기본 20초 timeout 및 caller abort 지원.
- fetch/clock/sleep/random 주입 가능. unit test의 HTTP 응답은 모두 fake이다.
- 원문 body, financial 값, 연락처, Authorization, 원본 error/stack을 로그에 출력하지 않는다.

## SEC Policy

- 전역 요청 시작을 gate 안에서 직렬화해 종목/endpoint/retry를 합쳐 1 request/s 이하.
- ticker당 Submissions + CompanyFacts + retry를 **합산 최대 3회**.
- run-level `maxFetchAttempts`/`maxProviderRequests`: policy에서 강제하며 기본 상한 300.
- 429의 유효한 seconds/HTTP-date `Retry-After`를 준수. 60초 초과 지시는 일찍 재시도하지 않고 중단한다.
- 5xx/network/timeout: 제한된 지수 backoff + jitter. 원문 오류는 고정 범주로 치환.
- 403: 전역 circuit을 열어 다음 ticker의 실제 요청도 차단. caller abort는 retry하지 않는다.

## Automation Policy

파일: `scripts/sec-raw-automation-policy.mjs`.

별도 strict schema를 구현했다. historical promotion envelope는 이 schema에서 거부된다.
Production policy 파일은 만들지 않았고 synthetic fixture만 사용했다.

검증 필드:

- `policyVersion`, `release`, `schemaVersion`.
- `target.accountId/databaseId/databaseName/queueId/queueName`.
- `scope`의 ticker/CIK, `allowedForms`.
- `maxPayloadBytes`, `maxPublishesPerRun`, `maxPublishesPerDay`.
- `maxFetchAttempts`, `maxProviderRequests`.
- `validFrom`, `expiresAt`, `secFetchEnabled`, `productionEnqueueEnabled`.
- `policyManifestHash`: canonical manifest SHA-256.

HEAD/release·target·scope·CIK·schema·budget·hash·유효기간 불일치, LMT, 100 초과 scope,
미지원 form, 추가 필드, payload 상한 초과는 fail-closed이다.
정책의 hash는 변조 검출용이며 자체적으로 운영 승인을 만들어 주는 서명은 아니다.
후속 runner는 검토된 정책 파일과 실제 checkout HEAD를 전달해야 한다.

## Run-Level Readiness

파일: `scripts/sec-raw-automation-readiness.mjs`.

- adapter의 account/DB identity가 policy target과 일치해야 한다.
- scope-sized LEFT JOIN **한 번**으로 migration >=22, historical checkpoint,
  raw runtime schema/data version, ready/pending 상태 및 기록/available count를 검사한다.
- raw/provenance 전체 row scan 없음.
- receipt의 `runId/policyHash/release/scopeHash/target/verifiedAt/expiresAt`와 historical anchor를 깊게 freeze한다.
- 메모리 WeakSet으로 발급한 receipt만 허용한다. 복제/위조 receipt, scope 변경, 다른 run, 만료는 거부.
- ticker별 compact checkpoint, runtime, 최신 Annual 10개/Quarterly 40개 anchor 조회는 **작은 SELECT 3회**.
- 공통 D1 read 실패는 후속 SEC 요청/발행을 중단한다.

## Producer Journal

파일: `scripts/sec-raw-producer-journal.mjs`, `scripts/sec-raw-github-journal.mjs`.

| 상태 | 의미 / 재발행 |
| --- | --- |
| INTENT | POST 전 영속 예약. crash 이후 즉시 재발행하지 않음 |
| ACCEPTED | Queue 수락/in-flight. DB 완료 아님, 동일 source 재발행 금지 |
| AMBIGUOUS | timeout/network/5xx/불완전 성공 응답. 자동 retry/republish 금지 |
| FAILED_SAFE | deterministic 4xx 거부. operator 판단 전 동일 source 재발행 금지 |
| COMPLETED_RECONCILED | exact accession/source/schema checkpoint 관측 |
| REVIEW_BLOCKED | exact source 처리 증거의 pending_review. 완료와 구별 |
| OPERATOR_REQUIRED | crash INTENT 등 운영 확인 필요 |

Entry는 ticker/accession/sourceIdentity/applicationIdentity/schemaVersion/policyHash/release,
생성·갱신 시각, runId, 예약된 단일 publish attempt 및 고정 transport 범주만 가진다.
raw payload/credential/오류 원문을 entry에 추가하면 schema 검증에서 거부한다.
`publishAttemptCount=1`은 예약된 최대 단일 전송을 나타내며 서버의 수락이나 실제 전송 완료 증거가 아니다.

### Backend / CAS

- in-memory fixture backend: restart snapshot, optimistic CAS contract 검증.
- local durable fixture backend: exclusive mutation lock, file fsync, atomic rename, restart/CAS 검증.
- GitHub Contents-style adapter: 별도 private repo, 비기본 `producer-state` branch,
  전용 `state/*.json`, 외부 연결 차단 확인 callback, optimistic SHA CAS.
- public repo/default branch/연결 차단 미확인/branch 미존재 404는 거부.
- CAS 충돌은 최대 3회. write 결과 불명확은 오류 원문 없이 중단하고 자동 write retry하지 않는다.
- GitHub 실제 API 요청 0. remote durability는 fake protocol contract 검증이며 실제 repo provisioning 검증이 아니다.
- 공식 Queue REST core는 memory/local fixture journal을 Production durable truth로 허용하지 않는다.

### Single writer / crash

- TTL + runId/owner로 단일 writer를 유지한다.
- 다른 writer는 충돌한다. stale lock은 자동 탈취/삭제하지 않는다.
- 명시 operator 승인 + 일치하는 stale owner/run을 확인한 해제만 허용한다.
- POST 전 INTENT 저장 실패이면 전송하지 않는다.
- POST 후 ACCEPTED 저장 실패이면 INTENT를 남겨 다음 run에서 OPERATOR_REQUIRED로 억제한다.
- DB checkpoint에 값을 쓰거나 journal을 DB 완료로 위조하지 않는다.

## Source Discovery

파일: `scripts/sec-raw-source-discovery.mjs`.

- Submissions recent에서 10-K/10-Q/10-K/A/10-Q/A를 선택.
- filed date/accession 오름차순으로 완료 anchor 이후의 지원 후보를 탐색.
- ticker당 run당 **pending 후보 최대 1개**. 미확정된 이전 message가 있으면 다음 accession도 발행하지 않는다.
- 여러 누락 공시는 oldest부터 처리하고, exact completion을 확인한 다음 run에 다음 후보를 처리한다.
- 같은 accession의 compact identity 변경은 correction 후보. 기존 consumer review/overwrite 정책은 그대로 유지.
- fact 배열 수신 순서만 달라지는 경우 오인하지 않도록 새 producer에서만 compact rows를 canonical 정렬.
- source-not-indexed는 이전 source를 발행하지 않고 지연 후보를 기록한다. 5/10/20분 간격, 최대 3회 후 operator 필요.
- 확인된 review source는 재발행하지 않으며 이후 새 accession까지 영구 차단하지 않는다.
- recent/archive 범위 밖의 공시 누락 가능성은 임의 건너뛰지 않고 `DISCOVERY_WINDOW_INCOMPLETE`로 안전 중단.
  archive loader 확장은 후속 gap이다.

## Dedupe / Reconciliation

- exact completed checkpoint: publish 0.
- 동일 source ACCEPTED/in-flight: publish 0, completion 전 window도 억제.
- AMBIGUOUS: 즉시 retry 0, 다음 run publish 0.
- exact source REVIEW_BLOCKED: publish 0. 변경된 source는 새 후보 가능.
- INTENT crash: OPERATOR_REQUIRED. 원본 source를 바로 다시 보내지 않는다.
- identity mismatch는 자동 완료 처리하지 않는다.
- 현재 runtime에는 sourceIdentity가 없으므로 `raw_status=pending`만으로 REVIEW_BLOCKED를 추측하지 않는다.
  core의 `reviewReader`에 source/schema/accession을 특정한 처리 증거를 주입해야 한다.
  증거가 없으면 ACCEPTED/in-flight suppression을 유지해 중복 발행은 계속 차단한다.

## Failure Isolation / Transport

- ticker의 source JSON/CIK/validation/fetch 오류는 해당 ticker만 실패하고 다음 승인 ticker를 계속 처리.
- policy/release/target/readiness/공통 D1/SEC 403/Queue auth-target/journal 안전성 오류는 전역 STOP.
- 새 automation REST transport는 run receipt + compact validation + strict policy를 요구한다.
- Queue POST는 단일 요청이다. 자동 retry 없음. messageId 존재를 가정하지 않음.
- 401/403 → auth STOP, 404 → target STOP, 429 등 deterministic 4xx → FAILED_SAFE.
- 5xx/timeout/network/invalid JSON/invalid success envelope → AMBIGUOUS.
- 기존 historical transport/discovery CLI는 변경하지 않았다. 새 자동화 core에서만 반복 전수 검증 없는 경로를 사용한다.

## 100 Ticker Scaling / Budget

- policy scope 배열을 사용하며 runtime ticker hardcoding 없음. 100 상한 유지.
- synthetic 100 ticker, 100 accepted message PASS.
- readiness 1회/run, ticker metadata group 100회/run. 실제 SQL adapter는 group당 SELECT 3회.
- N×M whole-scope/history audit 반복 0, raw/provenance full scan 0.
- 다음 run 100 ticker 모두 in-flight suppression, 추가 publish 0.
- run publish budget 및 journal의 UTC 날짜별 durable daily budget 강제.
- INTENT 예약과 daily budget 소비는 같은 CAS에 포함된다. crash/ambiguous도 예약을 되돌려 중복 전송하지 않는다.
- 한도 초과 ticker는 `BUDGET_EXHAUSTED`, publish 0, DB 완료 상태 불변.

## CLI / Scheduler

`npm run raw:scheduled-local -- --fixture <Git ignored 합성 fixture JSON>`

CLI는 ignored fixture만 읽고 actual HEAD와 policy를 대조한다.
remote transport가 없으며 detect-only다. `--enqueue`/credential/live 옵션은 거부한다.
합성 fixture CLI 성공 및 publish 0을 신규 테스트에서 직접 확인했다.

- GitHub workflow / Cron / scheduler 연결: NO.
- Production policy / 실제 credential / GitHub state repo 생성: NO.
- 라이브 실행 entrypoint wiring은 R10C 이후 별도 승인 범위다.

## Tests / 기존 Regression

| 검증 | 결과 |
| --- | --- |
| 시작 npm test | 982 PASS / 0 FAIL / 0 SKIP |
| 최종 npm test | 1,099 PASS / 0 FAIL / 0 SKIP |
| 신규 tests | 117 PASS |
| npm run check 및 r10b:check | PASS |
| r10b:audit | PASS |
| R3 / R5 / R6I audit | PASS |
| R7 / R8B / R8I-FIX / R9D-TEL offline audit | PASS |
| specialized / historical / inventory fixture audit | PASS |
| git diff --check 및 신규 파일 whitespace 검사 | PASS |

- historical: raw 9,062 / provenance 4,615 / missing 4,422 / needs_review 25.
- retention: 285/285. historical Run2 logical/raw/provenance/checkpoint mutation 0.
- 기존 financial 500행 및 보호 데이터/분류 불변.
- O specialized: definitions 14 / values 950 / provenance 1,344.
- combined digest: `4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5` 불변.
- Queue compact/idempotency/consumer/lease/fence/review/checkpoint/historical importer 의미 불변.
- UI/public API/Production config/기존 migration 0001~0022 수정 0.
- 선택적 외부 PDF 원문 재파싱은 기존 cache의 `inspections.json` 누락으로 **NOT VERIFIED**.
  재다운로드하지 않았다. R3는 cache 인자 없이, R5는 기존 R4 cache를 사용하여 실행했다.
  전문 지표의 full-count/digest 불변은 별도 R8I audit에서 승인된 기존 P75 artifact로 검증했다.
  외부 PDF 재파싱이 이번에 통과했다고 대체 보고하지 않는다.

## Migration

새 migration 없음. Production business D1에 producer journal을 저장하지 않는다.
기존 22개 migration 모두 baseline과 동일하다.

## Changed Files

실제 후보 변경은 다음 **18개**다. stage하지 않았다.

1. `package.json`
2. `scripts/sec-raw-automation-policy.mjs`
3. `scripts/sec-raw-source-fetch.mjs`
4. `scripts/sec-raw-producer-journal.mjs`
5. `scripts/sec-raw-github-journal.mjs`
6. `scripts/sec-raw-automation-readiness.mjs`
7. `scripts/sec-raw-source-discovery.mjs`
8. `scripts/sec-raw-automation-transport.mjs`
9. `scripts/sec-raw-scheduled-producer.mjs`
10. `scripts/sec-raw-automation-check.mjs`
11. `scripts/sec-raw-automation-audit.mjs`
12. `tests/helpers/sec-raw-automation-fixtures.js`
13. `tests/sec-raw-automation-policy.test.js`
14. `tests/sec-raw-source-fetch.test.js`
15. `tests/sec-raw-producer-journal.test.js`
16. `tests/sec-raw-scheduled-producer.test.js`
17. `tests/sec-raw-github-journal.test.js`
18. `docs/reit-metrics-r10b-report.md`

`backups/r10b`의 sanitized audit JSON/helper는 Git ignored evidence다. 원문/credential을 새로 보관하지 않았다.

## Secret Scan

- candidate 파일/추가 파일 allowlist, 실제 credential literal/환경 Secret 할당/이메일/개인키 검사 PASS.
- 로그 leak test: secret/raw payload/연락처 marker 미포함.
- 실제 API key/token/OAuth/email/SEC contact/환경파일/cache/PDF/SQLite/Production evidence 후보 포함 0.
- staged 파일 0. 기존 환경/credential 파일은 읽거나 사용하지 않았다.
- Observability token 재사용 0.

## Production / Git

| 작업 | 결과 |
| --- | --- |
| 실제 SEC/BQ/FMP/Massive 호출 | 0 |
| 실제 Cloudflare/D1/GitHub 요청 | 0 |
| Production Queue publish / D1 write | 0 / 0 |
| Worker/Pages deploy | NO |
| Queue/Cron/flag/Secret/token 변경 | NO |
| Production journal/migration/workflow | NO |
| commit / push | NO / NO |

Git은 clean이 아니라 **R10B 18개 controlled changes only**다. HEAD는 기준 checkpoint 그대로다.
Production 상태를 이번에 외부로 재조회했다고 주장하지 않는다. 이 Phase에는 운영 접속 자체가 없었다.

## Remaining Gaps / Next Step

1. checkpoint commit은 별도 승인 필요. 이번에는 만들지 않았다.
2. 실제 private automation repo/state branch, 연결 차단 검증, 최소 credential와 durable backend 운영 연결은 R10C 범위.
3. GitHub workflow/scheduled runner, 실제 HEAD/승인 정책 로딩, 승인된 Queue/D1 read-only adapter 연결은 미실행.
4. source를 특정한 pending_review telemetry evidence reader 연결/운영 contract 검증 필요.
5. Submissions archived files로 recent 범위 밖 catch-up을 확장하려면 별도 제한된 fetch budget 검증 필요.
6. 실제 SEC/live fetch 및 GitHub CAS/Queue enqueue를 운영 환경에서 검증한 것은 아니다. 별도 승인 gate에서 단계별로 진행한다.
7. 기존 선택적 PDF 원문 재파싱 cache 누락은 보존했다. synthetic/P75 artifact 검증과 구분한다.

## 마지막 YES / NO

1. live-capable Node SEC fetch 구현: YES
2. 실제 live fetch 0: YES
3. SEC pacing/retry/timeout 구현: YES
4. ticker failure isolation 구현: YES
5. strict automation policy 구현: YES
6. run-level historical readiness 구현: YES
7. 새 자동화 경로의 per-message whole-history audit 제거: YES
8. durable journal abstraction 구현: YES
9. queued suppression 구현: YES
10. ambiguous suppression 구현: YES
11. review suppression 구현: YES
12. crash-before/after-send 검증: YES
13. multi-accession catch-up 구현: YES
14. same-accession correction 감지: YES
15. source-not-indexed 처리: YES
16. 100 ticker scaling test PASS: YES
17. publish/run budget 구현: YES
18. Observability token 재사용 0: YES
19. migration 추가 없음: YES
20. 기존 982 tests 유지: YES
21. 신규 tests PASS: YES
22. Production 변경 0: YES
23. Git controlled changes only: YES
24. PRODUCER CORE READY FOR CHECKPOINT: YES
