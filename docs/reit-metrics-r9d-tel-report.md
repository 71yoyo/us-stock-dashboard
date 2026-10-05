# R9D-TEL — Queue Telemetry 계측 결과

검증일: 2026-10-05. 기준 HEAD: `3a2f0a11ea26f83aff021f2cae618611caea6caa`.
시작 Git clean 확인. 이번 변경은 로컬 코드·테스트·보고서만이며, 미커밋 상태다.

## [R9D-TEL Verdict]

**A. READY FOR TELEMETRY CHECKPOINT**

이는 코드 checkpoint 준비 판정이다. 실제 Production Queue CPU 및 invocation-specific D1 비용 확보를 뜻하지 않는다.
기존 R9D의 **B. PARTIAL / BLOCKED**는 유지한다. `Queue invocation cpuMs`와 `Production invocation-specific rows_written`은 여전히 **NOT VERIFIED**다.

## [Root Cause]

기존 consumer는 D1 응답 metadata를 invocation 단위로 모으지 않았다.
특히 `first()` 반환값에는 metadata가 없으므로 그대로 관찰하면 lease/checkpoint 조회 비용을 누락한다.
별도로 Workers Observability 설정·권한·실제 invocation 로그 확보가 필요하다.
계정 전체 Analytics 차이나 로컬 elapsed는 해당 Queue invocation 증거가 아니다.

## [Telemetry Architecture]

- CPU source: Cloudflare built-in invocation의 `$workers.cpuTimeMs`만 사용. 코드에 CPU 계산·elapsed 측정 없음.
- D1 source: 기존 실행의 `D1Result.meta`만 관찰. invocation마다 독립 collector 생성.
- flag: `SEC_STANDARD_RAW_TELEMETRY_ENABLED`. unset/false 및 문자열 `true` 이외 값은 OFF.
- queue processing flag와 독립. Queue-only entry에서만 적용하며 일반 앱 Worker 경로는 기존 처리 유지.
- OFF: wrapper·summary 생성 없음. ON: 기존 처리 후 `finally`에서 allowlist summary 한 건 출력.
- metadata 관찰 또는 logger 장애가 성공한 DB 결과/ack/retry를 실패로 바꾸지 않는다.

## [D1 Collector]

| 항목 | 의미 |
| --- | --- |
| `d1Calls` | 시도한 단일 실행 및 batch binding 호출 수; batch는 한 번 |
| `sqlStatements` | 단일 실행 수 + batch 안 statement 수 |
| `singleCalls` / `batchCalls` | 단일 실행/batch 분리 |
| `rowsRead` / `rowsWritten` | 각 응답 `meta.rows_read` / `meta.rows_written` 합계 |
| `d1DurationMs` | `meta.duration` 합계; CPU 또는 전체 wall time이 아님 |
| `rawDelta` / `provenanceDelta` | 해당 INSERT/UPSERT 응답 `meta.changes` 합계; 과금 write와 구분 |
| `checkpointChanges` | checkpoint statement의 `meta.changes` 합계 |
| `metaComplete` | 필요한 metadata가 전부 확보됐는지 |
| `failedCalls` / `observationFailures` | DB 실행 실패/metadata 관찰 실패 구분 |
| `observedRowsRead` / `observedRowsWritten` / `observedD1DurationMs` | 확보한 부분 합계; 전체 비용으로 간주하지 않음 |

`all()`/`run()` 및 `batch()`는 원래 반환값과 DB 예외를 보존한다.
ON의 `first()`는 **동일 SQL·bind를 `all()`로 정확히 한 번 실행**하고 첫 행/선택 column/null을 반환한다.
이는 metadata 없는 `first()`를 대체하는 한 번의 기존 실행이지 후속 SELECT가 아니다.
빈 결과, 0/false/null cell, 없는 column의 오류를 로컬 검증했다.
Queue runtime이 사용하는 all/run/first/batch만 계측하며, 미사용 exec/raw 등의 범용 계측으로 확대하지 않았다.
공식 [D1 prepared statements 문서](https://developers.cloudflare.com/d1/worker-api/prepared-statements/) 기준이다.

추가 queries: **0**. SQL 원문은 메모리에서 대상 종류만 분류하고 로그/collector snapshot에 보관하지 않는다.
meta 부재/잘못된 숫자/실패 응답은 관련 합계를 `null`로 표시한다. 실패 batch 비용을 rollback 사실만으로 0으로 추정하지 않는다.
raw/provenance delta는 변경 statement 수치이지 financial 값이나 테이블 전체 행 수가 아니다.

## [Structured Summary]

항목:

`event=sec_raw_queue_summary`, `summaryVersion`, `ticker`, `schemaVersion`,
`sourceIdentity`, `applicationIdentity`, `outcome`, `runtimeResult`,
`deliveryAttempt`, `attemptMeaning`, `retryRequested`, `retryRequestCount`,
collector 수치, `checkpointAction`, `messageCount`.

공식 Queue message의 `id`가 존재하고 안전한 형식일 때만 `messageId`를 포함한다. 임의 ID 생성 없음.
`deliveryAttempt`는 Queue `attempts`이며 runtime의 `attempt_count`와 다르다.
`outcome`은 앱의 ready/unchanged/review/retry/disabled/rejected/exception 의미이며 플랫폼 `$workers.outcome`과 구분한다.
검증 전 payload나 disabled/invalid payload의 identity는 추측하지 않고 null로 둔다.
복수 message도 summary는 invocation당 한 건이며, message별 안전한 identity/status만 `messages`에 포함한다.
정상·검증 거부·lease 충돌·DB 장애·retry·review·unexpected exception에서 한 건을 검증했다.
logger 장애나 플랫폼 강제 종료/CPU 제한으로 로그 자체가 확보되지 않으면 관측 성공으로 판정할 수 없다.

제외: SQL/binds, facts/CompanyFacts, financial 값, 원문 예외, lease token,
환경변수 값, OAuth/API token/credential, Authorization/header, 실제 이메일, DB ID.
sourceIdentity는 검증된 기존 idempotency hash만 사용한다.

## [Semantics]

- OFF parity: PASS. 기존 consumer 결과/DB 상태/SQL 목록 exact, summary 0건.
- ON parity: PASS. OFF와 반환값·DB 상태·SQL 목록·binding 호출 수 동일.
- idempotency: PASS. duplicate `unchanged`, raw/provenance/checkpoint/runtime 재작성 없음.
- retry: PASS. 기존 고정 retry delay 900초, store rollback·lease deferred·transient failure 유지.
- review: PASS. 정정/충돌 pending_review, 기존 값 및 완료 checkpoint 보호.
- processing disabled: 기존 retry 및 payload 미파싱/DB 호출 0 유지.
- migration, financial 계산, classification, UI/public API, historical importer: 변경 없음.

### 실제 cache를 이용한 로컬 OFF/ON 검증

R4 원문은 기존 source SHA-256과 대조했다. R6F 후보와 공식 compact producer를 재사용했다.
실제 원문을 새로 다운로드하지 않았고 실제 Queue에 발행하지 않았다.

| 종목 | initial raw / available | initial D1 calls / SQL statements | duplicate calls | duplicate writes | 추가 query |
| --- | --- | --- | --- | --- | --- |
| O | 67 / 44 | 7 / 12 | 3 | 0 | 0 |
| MSFT | 49 / 21 | 7 / 12 | 3 | 0 | 0 |

SQLite에서 저장 의미를 실제 실행하고 D1-shaped **합성 meta fixture**로 집계를 대조했다.
이 수치는 Cloudflare 과금량/CPU 실측으로 사용할 수 없다. 실제 rows_written에는 인덱스 비용 등이 포함될 수 있다.

## [R7/R8 Regression]

`npm run r7:audit`, `npm run r8b:audit`: PASS. 기존 cache/승인 artifact만 사용, source calls 0.

- historical raw/provenance/missing/review: **9062 / 4615 / 4422 / 25**.
- retention 복구: **285/285**. historical checkpoint: **10/10**.
- Run2: logical change 0, raw/provenance/runtime/checkpoint write 0, DML statement 0.
- 기존 financial 500행 불변. R8B의 추가 합성 보호 sentinel 50행도 불변.
- classification 및 business 보호 snapshot 불변.
- O specialized: **14 / 950 / 1344** 불변.
- combined specialized digest:
  `4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5`.
- compact O/MSFT 동일성 및 duplicate no-op 유지.

이는 로컬 회귀 검증이며 이번에 Production DB를 다시 조회하거나 수정하지 않았다.

## [Tests]

| 검증 | 결과 |
| --- | --- |
| 시작 npm test | 기존 944 PASS / 0 FAIL / 0 SKIP |
| 최종 npm test | **982 PASS / 0 FAIL / 0 SKIP** |
| 신규 테스트 | **38 PASS** |
| npm run check | PASS; 기존 check 및 신규 r9d-tel:check 포함 |
| npm run r9d-tel:audit | PASS |
| npm run r7:audit | PASS |
| npm run r8b:audit | PASS |
| git diff --check | PASS |

신규 테스트는 flag, D1 result 보존, meta 집계, batch/first, 실패·부재 metadata,
meta getter 장애의 fail-open, initial/duplicate, retry/rollback/lease/review,
disabled, 앱 Worker 제외, invocation 범위, logger/exception, 민감정보 누출 방지를 포함한다.
Queue-only browser bundle 검증 PASS. Node importer/full-history runtime/HTTP/scheduled entry 추가 없음.

## [Observability Configuration Plan — 미실행]

다음 별도 승인 rollout에서만 Queue consumer Worker의 설정을 변경한다.
아래는 계획 예시이며 실제 wrangler/Production 설정 파일에 적용하지 않았다.

```json
{
  "vars": { "SEC_STANDARD_RAW_TELEMETRY_ENABLED": "true" },
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
    "logs": { "enabled": true, "invocation_logs": true }
  }
}
```

한 건의 canary 증거를 빠뜨리지 않도록 sampling 1을 계획한다.
2026-10-05 확인한 Free Workers Logs 기준은 하루 200,000 log events, 보존 3일이다.
invocation log와 custom summary는 각각 log event로 취급하므로 용량을 별도로 확인해야 한다.
2026-12-01 예정 요금 변경 이후에는 다시 확인한다.
공식 [Workers Logs 문서](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) 근거.

Query 경로는 `POST /accounts/{account_id}/workers/observability/telemetry/query`이며,
공식 허용 권한은 **Workers Observability Write**다.
조회 API가 POST/Write 권한을 요구한다고 해서 DB write/deploy 권한까지 부여할 이유는 없다.
해당 계정 범위에 필요한 Observability 권한만 요청하고, Worker 단위 리소스 제한은 해당 토큰 유형에서 지원하는 범위를 확인한다.
이번에는 credential 접근·권한 검증·token 생성/교체를 하지 않았으므로 현재 credential 접근 여부는 **NOT VERIFIED**다.
공식 [Telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/) 근거.

후속 실제 검증에서는 eventType=queue, scriptName, scriptVersion, 승인 시간대를 먼저 제한한다.
플랫폼이 부여한 `$workers.requestId`를 중심으로 invocation의 `$workers.cpuTimeMs`와 custom summary를 결합한다.
sourceIdentity/applicationIdentity 및 공식 messageId/attempt도 대조한다.
시간이나 계정 delta만 비슷하다는 이유로 동일 invocation으로 추정하지 않는다.
metadata가 누락/잘림/샘플링되거나 권한이 부족하면 **NOT VERIFIED**다.
계측·로그의 추가 CPU 비용은 아직 실측하지 않았고 Free CPU PASS로 승격하지 않는다.

## [Migration]

**NO**. 새로운 migration 없음. 기존 0001~0022 불변.

## [Changed Files]

수정 3개:

- `package.json`
- `worker/src/sec-raw-consumer-entry.js`
- `worker/src/sec-raw-queue.js`

신규 6개:

- `worker/src/sec-raw-telemetry.js`
- `tests/sec-raw-telemetry.test.js`
- `tests/helpers/sec-raw-telemetry-db.js`
- `scripts/sec-raw-telemetry-check.mjs`
- `scripts/sec-raw-telemetry-audit.mjs`
- `docs/reit-metrics-r9d-tel-report.md`

기존 audit의 Git 제외 로컬 통계 파일 `backups/r7/local-audit.json`, `backups/r8b/local-audit.json`은 재검증 결과로 갱신됐다.
원문 cache/환경파일은 수정하지 않았다. Git 추가 대상에는 audit output/PDF/cache/임시자료 없음.

## [Secret Scan]

실제 API key/token/email/환경파일/credential 추가: **없음**.
테스트의 `synthetic-*` 문자열은 누출 방지용 가짜 표식이다.
로그 allowlist에 원문/SQL/binds/환경/credential 값 없음. 원문 오류를 summary에 복사하지 않는다.

## [Production]

**ALL NO**: deploy, Queue message/publish, Queue config/binding, flag,
D1 write, Worker setting, migration, Cron, Secret 변경 없음.
인증된 Cloudflare API 및 공급원 SEC/BQ/FMP/Massive 호출 0회.
공개 공식 문서만 읽었다. 실제 Production 처리 테스트 미실행.

## [Git]

- commit: **NO**
- push: **NO**
- HEAD: 기준 checkpoint 유지.
- status: 이번 R9D-TEL 9개 파일만 미커밋 변경. clean이라고 보고하지 않는다.
- staged: 없음.

## [Next Step]

다음 승인 단계는 telemetry checkpoint commit이다. 그 뒤 별도 승인으로
consumer 배포/Observability 설정/권한 확인 및 최소 canary를 수행해야 실제 CPU/D1 증거를 확보할 수 있다.
이번 작업에서 자동 commit·배포·message 재발행을 진행하지 않는다.

## [마지막 YES/NO]

1. D1 result.meta invocation 단위 집계 가능한가? **YES** — 코드·로컬 검증; 운영 증거는 미확보.
2. rows_written 직접 기록 가능한가? **YES** — meta 반환 시 직접 집계; 부재/실패는 null.
3. CPU를 local elapsed로 대체하지 않는가? **YES**.
4. telemetry flag 기본 OFF인가? **YES**.
5. telemetry ON/OFF semantic parity PASS인가? **YES**.
6. 추가 D1 query 0인가? **YES**.
7. duplicate no-op rows_written 0 검증 가능한가? **YES** — 로컬 fixture 및 DB no-op 검증.
8. raw/SQL bind/credential leakage 0인가? **YES** — allowlist·누출 회귀 테스트.
9. migration 추가 없음인가? **YES**.
10. 기존 944 tests 유지인가? **YES** — 944 + 38 = 982 PASS.
11. Production 변경 0인가? **YES**.
12. READY FOR TELEMETRY CHECKPOINT인가? **YES** — R9D 운영 실측 gate PASS와 구분.
