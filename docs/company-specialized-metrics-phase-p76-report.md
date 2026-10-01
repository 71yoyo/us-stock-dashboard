# Phase P7.6 — 관리자 실행경로와 coordination 최종 검증

최종 판정은 **B — 추가 보완 필요**다. 관리자 REST importer, 0019, lease/fencing, classification CAS와 remote 데이터 무결성은 구현·검증했다. Historical importer의 Worker Free CPU blocker는 분리했다. 그러나 **공개 조회 API의 production-equivalent CPU/10ms 통과는 검증하지 못했다.** 운영 승격 승인 artifact와 실제 원격 백업도 아직 실행하지 않았다. P8 운영 변경을 시작하지 않는다.

## 1. 시작 상태

- HEAD `f616bf0d3dd573073682943a4d0bc1acce17bc19`, Git clean.
- 603 PASS / 0 FAIL, check/p75:check/diff check PASS.
- 기존 외부 cache로 specialized, historical, inventory, full-historical, definition-review, modern, storage 감사 전부 PASS. 재다운로드 없음.

## 2. Historical Import Execution Path

| 기준 | A: 앱 Worker | B: 관리자 Node → D1 REST | C: 임시 관리 Worker |
|---|---|---|---|
| Worker CPU/invocation | Free runtime 예산 적용 | 앱 Worker 실행 없음 | 별도 Worker도 runtime 예산 적용 |
| 인증·노출 | HTTP 인증/노출 정책 필요 | 관리자 API credential, 공개 route 없음 | 별도 인증/route/배포 관리 필요 |
| atomic batch | D1 binding batch | REST batch 실제 rollback 검증 | D1 binding batch |
| 재현·관측 | request timeout/로그 제한 고려 | 고정 artifact, 문서별 controller 검증/usage | version/route 종료까지 관리 |
| 종료·rollback | 앱 수명주기와 섞임 | 프로세스 종료, 문서 transaction rollback | route/Worker 제거 별도 필요 |

**최종 선택: B.** 기존 store의 prepare/batch contract를 관리자 REST adapter로 재사용한다. parser를 재실행하지 않고 승인된 immutable artifact만 읽는다. concurrency=1이다.

공식 [D1 REST query](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)의 `{batch:[{sql,params}]}`를 사용한다. REST에서 CHECK 오류를 실제 발생시켜 앞선 SQL도 되돌아가는 것을 확인했다. binding의 [transaction batch 설명](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)만 보고 REST 원자성을 추측하지 않았다.

제한이 없어지는 것은 아니다. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)의 SQL 100KB, bind 100, query duration 30초, DB 용량/단일 스레드 제한을 유지한다. [Cloudflare API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/)는 계정/사용자 누적 1,200회/5분, IP 200회/초다. adapter는 기본 275ms 간격, 동시 importer 1개로 실행한다. 다른 dashboard/CLI 사용량도 합산해야 한다. 429는 자동 폭주하지 않고 운영자 확인을 요청한다.

## 3. Worker Free CPU 영향

관리자 import는 Node에서 JSON/hash/preflight를 계산하고 REST로 D1에 요청하므로 앱 Worker의 10ms CPU나 invocation별 50회 제한을 importer gate로 사용하지 않는다. D1 및 API 제한은 여전히 적용한다. P7.5 private preview가 50회 제한을 통과했다는 주장도 그대로 하지 않는다.

신규 조회 API는 실제 Worker 실행이므로 별도 gate다. [Workers CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) 및 [공식 local profiling 설명](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/)에 따라 local 표본을 production billing CPU로 바꾸어 해석하지 않는다.

## 4. Production Importer

`scripts/specialized-production-import.mjs`는 앱 Worker와 분리된 entry다. 기본 verify-only이며 adapter에서도 write를 거부한다.

필수 입력: `--db-id`, `--db-name`, `--expected-db-name`, `--artifact`, `--dataset-version`, `--artifact-sha256`.

실제 apply는 `--apply`와 해당 환경의 이름 confirmation이 필요하다. 운영은 `--confirm-production us-stock-pro` 및 `--approval <운영 승격 envelope>`까지 필요하다. rehearsal은 `--rehearsal`과 정확한 disposable 이름 confirmation을 요구한다. 옵션/artifact를 검사하기 전에는 인증이나 원격 요청을 하지 않는다.

Guard:

- 실제 GET DB ID/name과 allowlist 확인.
- artifact bytes SHA, semantic digest, 원래 parser commit, source hash/URL/issuer 40/40, dataset identity 확인.
- migration 0017/0018/0019와 모든 필수 table 확인.
- registry fingerprint 비교, 외부 dataset/알 수 없는 specialized record/source STOP.
- registry 없는 기존 값도 STOP. 운영 데이터와 무조건 합치지 않는다.
- 완료 dataset는 apply를 줘도 digest·40문서 read verification만 수행한다.

API token은 환경변수 또는 기존 Wrangler 로그인에서 메모리로만 읽고 출력/파일에 저장하지 않는다. CI에서는 계정 범위를 제한한 D1 credential과 환경변수를 사용한다. 기존 운영 Secret을 바꾸지 않았다.

## 5. Dataset Registry

필요: **YES**. 값/출처만 보면 실행 의도·완료 여부·중단 위치를 구분하기 어렵다. lock에 완료 이력을 섞으면 takeover가 이력을 손상시킬 수 있다.

`specialized_import_registry`는 stable key `REALTY_INCOME_FFO_AFFO_2016_2025_V1`, dataset version, target 환경/DB, artifact SHA, semantic digest, parser commit, status, attempt count, 진단용 마지막 문서/완료 문서 수를 보존한다. 문서 번호로 skip하지 않는다. 복구는 동일 전체 artifact rerun이다.

현재 payload version `realty-income-2016-2025-p75-v1`는 변경하지 않았다. 운영 실행은 별도 envelope가 `productionPromotionApproved=true` 및 production target/동일 fingerprint를 명시해야 한다. rehearsal 승인을 운영에 자동 사용하지 않는다. **이번에는 운영 승격 envelope를 발급하지 않았다.**

## 6. Single-writer Coordination

별도 global `specialized` lease와 registry를 분리했다. 서로 다른 dataset도 동시에 쓰지 못한다. 기존 fundamental queue lease는 의미가 달라 변경/재사용하지 않았다.

각 문서 batch 앞/뒤에 DB 시각 기반 owner/dataset/fence/expiry CHECK를 INSERT/upsert guard로 강제한다. row 삭제 시 UPDATE 0행으로 검사를 우회할 수 없다. 문서 실패는 전체 rollback, 이전 문서는 보존한다.

## 7. Migration 0019

필요: **YES**.

`0019_specialized_import_coordination.sql`:

- `specialized_import_registry`: dataset identity/상태/진단.
- `specialized_import_lease`: importer 전체 owner/expiry/단조 fence.
- `specialized_import_guard`: 한 row의 강제 CHECK.

기존 0001~0018 수정 없음, 기존 numeric/분류 값 UPDATE/DROP 없음. Fresh/Existing SQLite 검증 PASS. 실제 적용은 기존 disposable D1에만 수행했다. production 적용 **NO**.

## 8. Lease/Fencing

빈 lock 획득, active 다른 owner 거부, 동일 owner renewal, expiry takeover fence 증가, owner/fence 조건 release PASS. Concurrent acquire 2개 중 정확히 1개 성공.

권장 기본 TTL=120초, 각 문서 직전 renewal. P7.5 문서 batch 1초 안팎/HTTP 수초와 45초 관리자 HTTP timeout·bounded retry를 고려한 값이다. 긴 문서나 응답 유실은 attempt 직전 다시 renew한다. 소유권이 없어지면 안전 중단한다. 250ms는 expiry 시험에서만 사용했다.

remote stale owner 거부, transaction 중 owner/fence를 바꾸는 fault의 끝 guard rollback, guard 없는 상태의 SQLite rollback PASS. Production 임의 SQL writer까지 막는 권한 시스템이라는 뜻은 아니다. 모든 future specialized writer도 이 protocol을 사용해야 한다.

## 9. Classification Coordination

현재 production deployment `25fafa59-c6a1-463e-b826-848d57c9c521`, version `a7f2fb18-3976-4f84-9459-b752426d5864`.

배포된 JavaScript module을 GET하고 전후 deployment ID가 동일함을 확인했다. bundle SHA `6df30229b43cb7c07b3cc8c0e91de7f6ed092e4deda7a7dc45f1902456d33672`. `INSERT INTO companies`, `/api/sync`, scheduler는 있으나 `company_classification` 언급은 **0**이다. 실제 deployed version 기준으로 metadata writer와 classification writer를 구분했다. 전체 bundle/이메일은 저장하지 않았다.

`classification-backfill.js`는 sector/industry/CIK를 read → classify → transaction CAS → write한다. 변경이면 metadata를 다시 읽고 최대 3회 재분류한다. Guard와 classification statement는 같은 batch다. manual override를 수정하지 않는다.

별도 `specialized-classification-backfill.mjs` CLI도 같은 target/artifact/confirmation guard를 사용한다.

| 대상 | lease | CAS | queue pause/변경 |
|---|---|---|---|
| historical importer | YES | 해당 없음 | queue pause NO |
| classification backfill | NO — 동일 입력 CAS/upsert | YES | pause NO |
| 현재 scheduler | 별도 추가 NO | 관리자 backfill에 적용 | 기존 Worker 먼저 수정 NO |
| 현재 `/api/sync` | 별도 추가 NO | 관리자 backfill에 적용 | 현재 table writer 아님 |

새 로컬 Worker의 FMP profile 저장은 이미 metadata+classification을 같은 DB.batch로 저장하고 override를 보존한다. 이번에 해당 scheduler/route 코드는 변경하지 않았다. Worker 배포 직전 stale profile을 재검증·CAS 재수렴해야 한다.

## 10. Scheduler 영향

가격/Massive/배당/financial queue, Cron, 운영 scheduler 모두 변경/중단 없음. CAS는 read와 write 사이 race만 해결한다. backfill 후 metadata가 다시 바뀔 수 있으므로 최종 검증과 신규 Worker의 current/stale fallback을 함께 유지한다.

## 11. Remote Disposable Rehearsal

DB `us-stock-dashboard-p75-rehearsal-20261001`, ID `de3f265c-d6ec-4561-8a53-64effad66eb5`만 사용했다. 실제 이름/ID 확인 → 기존 값 digest 확인 → repo 밖 Git 제외 backup → specialized/registry namespace만 clear → 0019 검증을 수행했다. 기존 금융/회사 자료는 삭제하지 않았다.

- REST atomic rollback PASS.
- Concurrent lease, renew/release/takeover/stale/end-fence PASS.
- Metadata race를 실제 UPDATE로 주입, CAS 2회째 현재 BANK/새 CIK 반영 후 원 metadata로 복구.
- Classification 10종목 검증.
- 40-document Run1: 14 definitions / 950 values / 1,344 provenance.
- Run2: 동일, completed registry에 따라 verify-only, **rows_written=0**.
- failed 상태 full artifact rerun: 동일.
- 값 충돌 거부, 이전 digest 유지.
- Quarterly FFO/AFFO/NFFO=40/40/19, Annual=10/10/5, YTD=20/20/10.
- 최신 CLI로 completed dataset를 다시 verify-only 실행: REST 149회, SQL 148개, rows_written=0, 같은 digest. 분류 CLI verify-only도 10종목 stale/missing=0.
- 기존 financial 데이터 변화 없음. 격리 DB의 financial rows는 비어 있었으므로, 비어 있지 않은 numeric sentinel 보존은 별도 SQLite regression에서 확인했다.

P6/P7.5/최종 remote combined digest:

`4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5`

첫 remote 전체 rehearsal: REST 1,077회 / SQL statements 6,952 / rows_read 182,058 / rows_written 11,138 / D1 duration 합계 2,785.59ms. Import/rollback/backup/검증/diagnostic를 합친 값이며 import 한 번의 비용이나 CPU가 아니다. Source 원문 재다운로드 없음.

## 12. Query/API Preview

Node REST query와 localhost workerd에서 9개 series를 비교했다. Worker read-only handler는 2 SELECT, write 0, public GET/운영 binding 거부다. 90개 measured 요청과 별도 warm-up을 실행했다.

Windows Miniflare native D1 bootstrap이 응답하지 않아 해당 프로세스를 종료했다. 로컬 profile은 동일 승인 fixture를 가진 Node SQLite read-only service bridge로 바꾸어 진행했다. **이 경로는 실제 remote D1 Worker binding과 같다고 주장하지 않는다.** remote D1 query는 별도로 REST에서 통과했다.

큰 원문 JSON 전체를 반환하지 않고 query에서 필요한 6개 metadata만 SQL projection하도록 개선했다. 원문 DB는 변경하지 않았다. 개선 전/후 remote 9개 query result hash는 전부 일치, rows_written=0. 기존 query 테스트도 유지한다.

실제 query isolate의 DevTools profiler 표본을 수집했다. Local active estimate는 약 11~29ms/요청, wall은 약 20~37ms였다. bridge·local 환경·sampling/GC/계측 영향이 있어 CPU 개선율이나 실제 Free 10ms 통과 근거로 사용하지 않는다. **production-equivalent read API CPU는 NOT VERIFIED.** 별도 비공개 production-equivalent runtime 계측 또는 유료 예산 선택이 필요하다. 이번에 public route를 열지 않았다.

## 13. GitHub / Auto Deploy 전략

- main push: Pages+Worker production 가능, 금지 유지.
- Pages는 현재 GET 설정에서도 main production enabled/preview all `*`다.
- Worker non-production build enabled는 P7.5 dashboard 읽기 기록을 사용했다. 이번에는 해당 화면을 다시 조작하지 않았다. feature push도 preview/version upload 가능성이 있어 백업용으로 자동 승인하지 않는다.
- 선택한 원격 백업 방법: checkpoint의 `git bundle`와 SHA를 생성해 Cloudflare 미연결 별도 비공개 저장소에 업로드. 기존 GitHub origin/main/feature push를 필요로 하지 않는다.
- 실제 업로드 대상 선택/승인과 업로드는 미실행. 별도 연결되지 않은 private backup repository도 가능하지만 이번에 생성/push하지 않았다.
- 운영 배포는 승인된 local checkpoint에서 manual 진행하는 B를 권장한다. 마지막 main push는 auto deploy 설정/대상 revision을 재검증하고 별도 승인한다. 설정을 이번에 변경하지 않았다.

## 14. 최종 Production 순서

현재 실행 금지. 조건 충족 및 P8 승인 후:

1. P7.6 checkpoint → 미연결 원격 백업 → 운영 DB backup/bookmark·numeric digest.
2. 현재 deployed version과 metadata writer 재확인.
3. 0017 → schema/constraint 확인.
4. 0018 → schema/constraint 확인.
5. 0019 → coordination 확인.
6. Classification CLI CAS backfill/override 확인, 전체 pipeline pause 없이 stale 재수렴.
7. 운영 전용 promotion envelope 확인 → immutable artifact 관리자 import → 즉시 read verification → Run2 verify-only/digest.
8. Profile stale 재확인/CAS → 별도 CPU/compatibility gate를 통과한 Worker/API만 manual deploy.
9. Pages/UI는 별도 승인. 이번 Phase에는 UI 변경 없음.
10. 마지막 main push/자동배포 조정은 별도 승인 후 수행. 승인 revision과 배포 revision 동일성을 확인.

## 15. 기존 Regression

기존 603 테스트 유지, 40/40 parser, 14/950/1,344, P6/P7.5 digest, expected/query/provenance 보존. 0001~0018 수정 없음. P6 helper는 해당 Phase의 고정 18 migration baseline을 명시적으로 유지하고, 신규 0019는 별도 fresh/existing 테스트에서 검증한다. 예상 숫자를 바꾸어 회귀를 숨기지 않았다.

## 16. Test

최종 628 PASS / 0 FAIL(기존 603 + 신규 25). `npm run check`, `p75:check`, `p76:check`, `git diff --check` PASS. 7개 offline specialized audit 모두 PASS. Secret 검사 PASS.

신규 검증: 필수 옵션/safe-fail/대상 환경 확인, artifact hash/parser/dataset 오류, default verify-only/write confirmation, registry/idempotent completion/full rerun, migration fresh/existing 보호, global concurrent lease/expiry/fence/renew/release, guard deletion 우회 방지, metadata CAS/retry/override, private query/branch policy.

## 17. 수정 파일

- `worker/migrations/0019_specialized_import_coordination.sql`
- `worker/src/classification-backfill.js`
- `worker/src/specialized-metric-query.js`
- `scripts/specialized-d1-admin.mjs`, `specialized-import-safety.mjs`, `specialized-import-coordination.mjs`, `specialized-production-import.mjs`, `specialized-classification-backfill.mjs`, `specialized-release-policy.mjs`
- `scripts/p76-check.mjs`, `p76-readonly-audit.mjs`, `p76-remote-rehearsal.mjs`, `p76-query-worker.js`, `p76-query-preview.mjs`
- `tests/specialized-import-coordination.test.js`, `tests/helpers/specialized-metrics-db.js`
- `scripts/specialized-disposable-db.mjs`, `package.json`
- 이 보고서와 `realty-income-phase-p76-results.json`.

Generated artifact/manifest/disposable backup/raw usage/profile 결과는 Git 제외 `backups/p75`, `backups/p76`에만 보존한다. API key/token/실제 이메일/원문 PDF는 변경 파일에 포함하지 않는다.

## 18. Production 변경

production migration/write/Worker deploy/Pages deploy/backfill/restore/Cron/Secret/main push 전부 **NO**. 로컬 commit도 이번에는 요청되지 않아 하지 않았다. Disposable DB는 다음 단계용으로 유지한다. localhost workerd/inspector는 검증 종료 후 dispose했다.

마지막 운영 읽기 전용 검사도 migrations=16, companies=10, financial_metrics=500, provenance=5,223, rows_written=0이다. 운영 0019 적용이나 쓰기 검사로 대체하지 않았다.

## 19. 남은 Blocker

1. Specialized API의 production-equivalent CPU/Free 10ms는 미검증. local 표본은 PASS 근거가 아니다.
2. Production promotion envelope 및 P8 rollout 승인 미발급.
3. 실제 원격 백업 업로드 미실행. 연결 저장소 branch push로 대체하지 않는다.

Importer 자체에는 기존 Worker Free CPU blocker를 적용하지 않는다. Production 0019가 아직 미적용인 것은 이번 Phase의 금지사항이며, 로컬 구현 부재라는 뜻은 아니다.

## 20. 최종 판정

**B — 추가 보완 필요. 운영 반영을 시작하지 않는다.**

| 마지막 확인 | YES/NO |
|---|---|
| 1. Historical importer 실행경로 확정 | YES — Node/D1 REST |
| 2. Worker Free CPU blocker 분리 | YES — import와 API를 분리 |
| 3. production-grade lease/fencing 구현 | YES — 실제 적용은 격리 DB만 |
| 4. classification metadata race 해결 | YES — CAS/retry, queue pause 불필요 |
| 5. remote D1 최종 재검증 | YES |
| 6. 0019 필요 여부 확정 | YES |
| 7. GET route runtime 위험 별도 평가 | YES — production CPU 통과는 미검증 |
| 8. main push 없는 원격 백업 방법 확정 | YES — 미연결 bundle 업로드, 실행 미완료 |
| 9. production 순서 확정 | YES — 위 조건부 순서 |
| 10. 지금 P8 운영 반영 시작 가능 | NO |
