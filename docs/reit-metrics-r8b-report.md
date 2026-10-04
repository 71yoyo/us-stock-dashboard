# R8B — SEC Raw Production Blocker Resolution

## [R8B Verdict]

**A. READY FOR CHECKPOINT**. R8A의 코드/정책 blocker A~D를 구현하고 로컬 검증했다. 이는 Production rollout 승인이나 실제 원격 실행 검증을 뜻하지 않는다.

## [Starting State]

- 승인 HEAD: `cbb20c180652238423baea21c4f1030805c1854b`
- message: `Implement SEC raw queue architecture`
- 시작 Git: clean
- 시작 테스트: 873 PASS / 0 FAIL / 0 SKIP
- 시작/종료 npm check 및 R3/R5/R6I/R7 check·audit: PASS
- R8A 운영 baseline은 참고만 했으며 이번에는 Production credential/DB/Worker/Pages를 조회하거나 변경하지 않았다.

## [Blocker A — Production Approval]

### envelope

`scripts/sec-raw-promotion.mjs`의 strict validator가 다음을 필수로 받는다.

- approvalVersion, datasetVersion, checkpoint, issuedAt, expiresAt
- target DB name/ID
- tickers 및 정확히 같은 key 집합의 sourceHashes/CIK/periodAnchorHashes
- historical sourceIdentity/accession allowlist
- expected raw/provenance/missing/needsReview
- retentionExpected, minimumMigration, writeBudget
- Queue account ID/queue ID/name

실제 운영 ID/name은 새 runtime 코드에 고정하지 않는다. 이미 있는 운영 설정에서 deny 대상만 읽는다. 실제 승인 파일은 Git ignored local artifact로 받아야 하며 이 단계에서 운영 identity를 담은 파일은 생성하지 않았다.

예시는 `docs/sec-raw-promotion.example.json`이다. 첫 후보 10종목만 표시하고 LMT는 제외한다. 가상 DB와 미완성 placeholder/만료 시각을 사용하므로 그대로 실행하면 검증에서 거부된다. ticker 목록은 runtime 코드가 아니라 승인 manifest가 결정한다.

### verify-only

실제 identity → 0001~minimumMigration ledger → 필수 raw schema → 모든 ticker/CIK → 원문 bytes SHA-256 및 파싱 결과 → SEC financial period anchors → accession/sourceIdentity → 추출 expected → 기존 raw/provenance/runtime/checkpoint hash → 예상 write budget을 확인한다.

호출자가 write adapter를 넘겨도 read-only wrapper에서 SELECT만 허용한다. run/batch 및 다중 SQL 문장은 거부한다. 로컬 검증 write 0. verify-only는 write 권한 승인도 apply 성공 보장도 아니다.

### production deny-by-default

기존 target deny guard는 유지했다. 운영 target에 예외를 적용하려면 explicit apply, historical enable, explicit production approval, envelope, exact checkpoint/DB identity/scope/hashes/counts/migrations/유효시간, 선행 dry-run/verify-only evidence를 모두 확인한다.

모든 ticker를 쓰기 전에 먼저 전체 scope를 검증한다. 뒤 ticker의 source 오류가 앞 ticker의 부분 write를 만들지 않는다. 검사한 bytes/anchors는 내부 사본으로 고정한다. target guard의 예외 proof는 이 프로세스에서 실제 verify한 receipt만 인정하므로 boolean/위조 receipt로 통과할 수 없다.

evidence는 manifestHash, datasetHash, checkpoint, rowsWritten=0, mode, PASS 및 1시간 이내 시각으로 묶고 apply 직전 현재 입력/DB 상태와 재대조한다. DB 숫자가 바뀌면 count가 같아도 거부한다. 운영 apply는 실제 checkout HEAD와 clean Git도 필수다.

envelope/evidence는 관리자가 승인하는 로컬 입력이지 독립 기관의 전자서명이나 Cloudflare 인증 대체물이 아니다. 실제 Cloudflare credential 권한은 별도로 필요하다.

CLI 추가: `--verify-only`, `--approval-file`, `--evidence-file`, `--production-approval`. 승인/credential/evidence 파일은 Git ignored이고 untracked여야 한다. Node `--use-system-ca` 조건을 요구하며 TLS 우회는 없다.

## [Blocker B — Queue Isolation]

- queue-only entry: `worker/src/sec-raw-consumer-entry.js`
- HTTP handler: 없음
- Cron/scheduled handler: 없음
- financial scheduler/full-history runtime import: 없음
- flag isolation: `SEC_STANDARD_RAW_QUEUE_ENABLED`만 사용
- 앱 fields flag가 false/unset이어도 독립 compact 처리가 가능하다.
- 앱 Worker의 기존 index/fmp-sync/fundamental-sync/HTTP/Cron 코드는 수정하지 않았다.

shared executor의 버전/OFF 정책만 `sec-raw-runtime-policy.js`로 분리했다. Queue-only 실행에 필요한 gate는 별도 실행 객체에만 전달하며 앱 환경은 바꾸지 않는다. Queue ON이 앱의 legacy fields flag를 켜지 않는다.

실제 esbuild import graph와 bundle을 검사했다. graph는 compact validator/executor, raw store, lease/fence/checkpoint, 표준 지표 계산·기간 helper 및 Queue entry뿐이다. HTTP router, scheduled entry, `runFundamentalBatch`, `syncFinancialsFromSec`, `runStandardRawRuntime`, Node importer, UI 코드는 없다.

compact extractor는 기존 표준 계산 core를 재사용하되 validator가 단일 accession/허용 tag/최대 2,000 fact/64,000 bytes를 제한한다. 전체 CompanyFacts를 읽거나 가져오는 Worker 진입 경로는 없다. 기존 full-history runtime의 동작/flag 의미는 그대로다.

template: `worker/sec-raw-consumer.template.jsonc`. 가상 이름/DB/Queue placeholder만 포함하며 processing false, workers.dev false, Cron 없음. 실제 생성/배포/config 적용은 하지 않았다.

## [Blocker C — Review Completion]

0022의 historical channel checkpoint를 **승인 source payload 처리 완료**로 사용한다. 지표가 전부 reviewed/validated라는 뜻은 아니다.

- 원자 raw/provenance 저장이 완료되면 needs_review가 남아 있어도 historical checkpoint 기록
- O/ABT/TSLA registry는 pending 유지
- needs_review 25건 및 NULL 유지
- raw_last_accession/raw_last_success의 기존 성공 의미 유지
- 값 정정/NULL 해소 후보를 승인 없이 overwrite하지 않음
- compact channel의 기존 정정/review checkpoint 정책은 변경하지 않음
- checkpoint write 실패 시 같은 batch의 raw/provenance도 rollback

같은 historical accession + sourceIdentity + 버전 + 무결성 확인이면 pending review source도 처리 완료 shortcut을 사용한다. changed identity/new accession은 다시 처리하며 review 상태를 자동 승격하지 않는다.

| 검증 | 결과 |
|---|---:|
| Run1 source processing checkpoint | 10/10 |
| needs_review | 25 유지 |
| Run2 raw write | 0 |
| Run2 provenance write | 0 |
| Run2 checkpoint write | 0 |
| Run2 registry meaningful write | 0 |
| Run2 runtime logical change | 0 |
| Run2 SQLite total changes | 0 |
| Run2 DML statements/batch | 0/0 |

기존 row가 있으면 shortcut 앞의 INSERT OR IGNORE도 실행하지 않아 Run2는 SELECT만 사용한다. 이는 실제 SQLite 논리 변경과 SQL 문장 측정이다. Production D1 과금/CPU를 이번 결과로 대체하지 않는다.

## [Blocker D — Queue Transport]

`scripts/sec-raw-queue-transport.mjs`에 공식 API adapter를 구현했다.

- account/queue ID/name/credential injectable, 기본 disabled/dry-run
- enabled + 승인 queue identity + 유효 manifest + compact validation 필수
- ticker scope/CIK/accession/sourceIdentity/version/size 검증
- historical scope 전체의 checkpoint/identity/registry/provenance 무결성 확인
- 실제 전송 직전 공식 Queue metadata GET으로 ID/name 재확인
- 공식 `POST /accounts/{account_id}/queues/{queue_id}/messages`
- JSON body `{ body: message, content_type: "json" }`
- timeout 기본 10초, 최대 45초
- 자동 retry 기본 0, 명시 요청 시 429/5xx만 최대 2회 추가 시도
- 401/403/404/불명 응답/timeout/network 오류 자동 retry 없음
- timeout/network는 이미 수신했을 수 있는 AMBIGUOUS 결과로 취급
- 오류에는 고정 code/HTTP status/attempts/숫자 Cloudflare error code만 포함
- body/header/credential/서버 message는 로그 또는 반환 오류에 포함하지 않음
- enqueue success는 queued이며 raw ready를 의미하지 않음

retry backoff는 기본 1초·2초이며 POST 시도 상한이 고정돼 retry storm을 만들지 않는다. Queue consumer의 900초 lease/transient retry와 별도 정책이다. Node CLI는 system CA 조건을 강제한다.

사용한 공식 규격: [Queue Push Message](https://developers.cloudflare.com/api/resources/queues/subresources/messages/methods/push/).

## [Discovery / Execution Plan]

`scripts/sec-raw-discovery-runner.mjs`와 `npm run raw:discover`를 추가했다.

- ticker/list, dry-run, detect-only, enqueue-enabled, one-shot
- 입력 원문 loader는 injectable; CLI는 승인된 local cache만 읽음
- 단일 accession compact 생성, current compact checkpoint와 identity 비교
- 같은 accession이라도 sourceIdentity 변경은 신규 처리 후보
- 동일 accession/identity는 unchanged
- 실제 enqueue 전에 scope 전체 historical source 처리 완료를 요구
- pending review는 processing 미완료와 구분하여 허용
- 실제 enqueue CLI는 clean checkpoint 및 ignored manifest/credential을 요구
- 자동 금융 API 호출/24시간 daemon/Production scheduler 없음

실행 위치 비교:

| 후보 | 판단 |
|---|---|
| local admin Node one-shot | 첫 canary에 권장. 승인 파일·source 입력·성공 결과를 사람이 확인 가능 |
| scheduled external runner | 이후 운영 자동화 후보. runner availability/credential 보관/락/실패 감시를 별도 승인·설계해야 함 |
| CI/manual job | 수동 실행 가능하지만 workflow/GitHub Secret/배포 연동 변경은 별도 승인 대상 |

이번 단계는 interface까지만 완성했다. 향후 신규 원문 acquisition과 지속 실행 위치는 별도 운영 계획이며 앱 Worker Cron에 full CompanyFacts 처리를 다시 연결하지 않는다.

## [LMT]

- initial historical scope 포함: NO
- runtime ticker hardcode: 없음
- 로컬 보호 검증: LMT financial 50행, provenance, classification, job 상태 불변
- LMT raw historical 생성: 0
- LMT discovery/enqueue: scope에서 거부

LMT 검증 row는 기존 AAPL 값을 복사한 **합성 보호 sentinel**이며 실제 LMT financial 값으로 표시/저장하지 않았다. 원래 10종목 500행과 함께 총 550행을 로컬 보호 대상으로 검증했다. 실제 Production LMT 자료는 이번에 읽거나 변경하지 않았다. 향후 LMT 활성화는 별도 source acquisition/hash/expected/manifest 승인이 필요하다.

## [Migration]

0023 needed: **NO**. 0022의 historical source checkpoint와 기존 pending registry로 의미 분리가 가능하다. 기존 0001~0022 파일은 불변이고 Production apply도 없다.

## [Local Historical]

기존 R4 cache 10개를 acquisition ledger의 SHA-256/CIK와 비교하고 재사용했다. 새 SEC/BQ/FMP/Massive/Cloudflare 호출 0.

- raw: 9,062
- provenance: 4,615
- missing: 4,422
- needs_review: 25
- retention: 285/285
- checkpoint: 10/10
- review ticker: O/ABT/TSLA 유지
- verify-only write: 0
- Run2 모든 write/logical change: 0

실제 운영 target의 승인 envelope는 생성하지 않았다. local audit용 가상 target manifest는 메모리에서만 사용한다. raw cache/SQLite DB/원문 결과는 tracked 파일로 저장하지 않았다.

## [Queue Consumer Tests]

entry의 fetch/scheduled 부재, OFF no processing, ON 독립 compact 처리, 실제 bundle graph를 확인했다. O 67 raw/44 available, MSFT 49 raw/21 available은 기존 R6F/R6I 후보와 deep equality PASS. 중복 compact delivery write 0. 기존 R7 correction/restatement/review/fencing/atomic rollback 테스트도 유지했다.

## [Transport Tests]

injected fetch로 200/201/202 success, 401, 403, 404, 429, 500, 503, timeout, network exception, invalid response, malformed payload, disabled/dry-run, remote identity mismatch, 미승인 ticker, historical 미완료/identity 불일치/provenance 누락을 검증했다.

credential은 합성 문자열만 사용했고, 테스트에서 서버 message/credential이 오류에 섞이지 않음을 확인했다. 실제 Queue는 만들거나 전송하지 않았다.

## [Rehearsal]

Remote rehearsal: **NOT EXECUTED**. 이번 gate는 로컬 DB 및 injected fetch로 충족했다. remote write/quota/CPU benchmark가 필요하지 않아 기존 rehearsal Worker/Queue/D1을 사용하지 않았다. 실제 revised consumer/transport 원격 검증은 향후 승인 단계에서 별도로 필요하다.

## [Tests]

- old: 873 PASS
- new: 48 PASS
- total: **921 PASS / 0 FAIL / 0 SKIP**
- npm run check: PASS
- r3:check/r3:audit: PASS
- r5:check/r5:audit: PASS
- r6i:check/r6i:audit: PASS
- r7:check/r7:audit: PASS
- r8b:check/r8b:audit: PASS
- git diff --check: PASS

## [Regression]

- 기존 10종목 financial 500행/출처/분류 불변
- 11종목 conceptual/LMT 합성 보호 50행까지 포함한 550행 보호 PASS
- 기존 specialized 승인 artifact 재사용: 14/950/1,344
- combined digest 불변: `4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5`
- R5 counts/retention 불변
- R6I compact semantics 및 R7 Queue idempotency/correction/review regression PASS
- GENERAL/BANK/REIT UI/public API/financial calculations 변경 없음
- 기존 full-history runtime의 처리는 유지, 버전/flag export 경로만 분리
- Total Debt/Net Debt/EV/EV-EBITDA 신규 구현 없음
- 실제 Production regression 재조회/CPU/D1 billing: 이번 범위에서는 실행하지 않음

## [Changed Files]

수정 5개:

- package.json
- scripts/sec-raw-historical-import.mjs
- worker/src/sec-raw-queue.js
- worker/src/sec-standard-raw-incremental.js
- worker/src/sec-standard-raw-runtime.js

신규 12개:

- scripts/sec-raw-promotion.mjs
- scripts/sec-raw-queue-transport.mjs
- scripts/sec-raw-discovery-runner.mjs
- scripts/sec-raw-promotion-check.mjs
- scripts/sec-raw-promotion-audit.mjs
- worker/src/sec-raw-consumer-entry.js
- worker/src/sec-raw-runtime-policy.js
- worker/sec-raw-consumer.template.jsonc
- tests/sec-raw-promotion.test.js
- tests/helpers/sec-raw-promotion-fixtures.js
- docs/sec-raw-promotion.example.json
- docs/reit-metrics-r8b-report.md

bundle audit의 재현성을 위해 현재 설치된 esbuild 0.28.1을 직접 devDependency로 명시했다. dependency 다운로드/업데이트/Production 설정 변경은 하지 않았다. 진단 로그/결과는 Git ignored `backups/r8b`에만 있다.

## [Secret Scan]

변경/신규 파일 및 staged 상태 검사: 실제 API key/token/OAuth/Observability token/이메일/운영 account identity/환경파일/원문/cache/PDF/SQLite/remote results 포함 없음. 실제 approval 파일 없음. 예시 target/테스트 credential은 합성이고 실제값이 아니다. staged 파일 없음.

## [Production]

ALL NO: migration, DB write, historical import, Worker deploy, Queue/DLQ create, binding, flag, Cron, Secret, Pages, backup upload.

## [Git]

- commit: NO
- push: NO
- HEAD 불변
- status: R8B 17개 파일 변경/신규, 미커밋. 이번 구현 요청의 정상 결과이며 clean이라고 보고하지 않는다.

## [Remaining Blockers]

R8B 코드/정책 gate는 통과했다. 다음 **운영 승격 gate**는 아직 미완료다.

1. 별도 승인 후 R8B checkpoint commit
2. 해당 checkpoint의 disconnected private backup upload/hash/restore 검증
3. 실제 Production 승인 envelope/evidence 발급
4. rollout 당일 fresh D1 quota/Time Travel/보호 baseline 및 실제 원격 비용 gate
5. 승인된 consumer 배포·Node 전송 경로의 controlled remote canary/CPU/D1 검증
6. 장기 실행 위치/신규 source acquisition 운영 승인

현재 cbb20c1의 원격 복구 백업 없음은 그대로 유지한다. HTTP/Cron Free CPU FAIL을 이번 코드 작업으로 PASS로 바꾸지 않았다.

## [Next Step]

별도 checkpoint 승인 → 로컬 commit → disconnected private backup/복구 gate 순서다. 이후 fresh preflight와 명시적인 Production promotion 승인이 있어야 rollout을 시작한다. 이번에는 commit/push/remote upload/배포를 하지 않는다.

## [마지막 YES/NO]

1. 승인 envelope 없이는 Production historical write 금지인가? **YES**
2. verify-only write 0인가? **YES**
3. Queue-only consumer가 앱 HTTP/Cron raw와 분리됐는가? **YES**
4. Queue ON이 legacy full-history path를 활성화하지 않는가? **YES**
5. needs_review 25를 보존했는가? **YES**
6. historical source checkpoint 10/10인가? **YES**
7. 동일 source Run2 logical/write 0인가? **YES**
8. Node Queue transport가 구현됐는가? **YES** — 공식 API adapter/mock 검증. 실제 Production send는 NO.
9. LMT initial scope 제외가 안전한가? **YES**
10. 기존 financial/O specialized가 불변인가? **YES** — 로컬 회귀, Production 변경 0.
11. Production 변경 0인가? **YES**
12. READY FOR CHECKPOINT인가? **YES** — Production rollout READY 판정은 아님.
