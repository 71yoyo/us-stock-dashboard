# Phase P7.5 격리 Remote D1 리허설 결과

최종 판정은 **B — 추가 보완 필요**다. Remote 저장·migration·rollback·idempotency·의미 digest는 통과했지만,
private preview의 성공만으로 Workers Free 제한/10ms CPU를 검증했다고 볼 수 없다. 운영 실행은 승인하지 않는다.

## 1. 시작 상태

HEAD `c6fbf35afe208eb74eca92afcdc9d523fa69ef11`, Git clean. 기존 596 PASS/0 FAIL,
`npm run check`와 `git diff --check` PASS로 시작했다.

## 2. Disposable Remote D1

이름 `us-stock-dashboard-p75-rehearsal-20261001`, ID `de3f265c-…-6eb5`.
생성 시각 `2026-10-01T07:39:48.670Z`(한국 16:39:48). 운영과 다른 실제 ID·이름을 `d1 info`로 확인했다.
APAC, read replication disabled. 최종 승인 검토까지 유지한다.

## 3. Remote Migration

0001~0016 PASS → 중간 schema 확인 → 0017만 PASS → 중간 schema 확인 → 0018만 PASS.
별도 migration directory/config로 다음 단계의 자동 연속 적용을 막았다.
0017 classification table/index, 0018 definition/value/source table/index가 각 단계에만 나타났다.
최종 격리 DB에서 invalid profile와 0 multiplier UPDATE를 실제 실행해 CHECK 거부를 확인했다.
기존 migration 파일·운영 설정은 수정하지 않았다. 운영은 여전히 0016까지다.

## 4. Classification

현재 운영 `/api/companies`를 GET으로 읽은 최소 metadata로 10개 회사 fixture를 준비했다.
기존 industry rule로 O→REIT, JPM→BANK, 나머지 8개→GENERAL. profile ticker 하드코딩은 없다.
Run2 row 증가 0, rule/effective profile 동일. O의 synthetic GENERAL override가 재분류 후 보존됐으며 시험 후 해제했다.
`classified_at`/`updated_at`은 재실행 시각이므로 의미 비교에서 제외했다.

## 5. Free Query Limit

최대 문서 `2021-q2`: 기존 preflight SELECT 51회 + 실제 write batch 99 statements.
계측/identity/count 조회까지 포함한 요청은 SQL 시도 157개, D1 RPC 59회, wall 9,841ms였다.
batch는 래퍼 관찰상 RPC 한 번이었다. 별도 SELECT 60회 probe도 private remote preview에서 성공했다.

따라서 **실제 remote 호출수 계측 YES, Free 50회 제한의 동일한 적용 검증 NO**다.
[D1 공식 제한](https://developers.cloudflare.com/d1/platform/limits/)은 Free 50회라고 명시하지만,
[최신 Workers 제한](https://developers.cloudflare.com/workers/platform/limits/#subrequests)은 Free 외부 subrequest 50회와
내부 서비스 1,000회를 구분한다. 두 문서의 기준 차이와 preview 적용 예산을 이 시험으로 확정하지 않았다.
60회 성공을 곧바로 무제한/유료 예산 증거로 해석하지 않는다. 구조 보완 필요 YES(조회 latency 및 문서 기준 불확실성).

## 6. Store 구조 보완

문서별 개별 51 SELECT를 definition/value 두 bulk SELECT로 줄였다. 정의 33 tuple/99 bind,
값 100 key 이하씩 나눈다. 모든 기존 정의 9열·값 18열의 충돌 검사와 검증상태 승격 규칙은 유지했다.
blind upsert로 대체하지 않았다. 추가 121개 synthetic record 테스트에서 최대 100 bind 확인.
P6 digest·기존 596개 테스트·audit 결과 불변.

## 7. 99-statement Remote Batch

기존 실제 99개 batch 성공, batch wall 853ms, rows_written 294, 오류/timeout 없음.
lease 보호 버전은 문서 99개에 시작/끝 fence guard를 더해 실제 101개 batch도 성공했다.
초기 보호 batch wall 812ms, rows_written 296. 48 values/48 provenance/3 definitions의 논리 행 수와 과금 write 수는 다르다.
최종 강화 경로는 guard row 존재 및 소유권을 preflight 이전에도 확인한다.

## 8. Remote Atomic Rollback

batch 마지막에 시험용 CHECK 위반 INSERT를 추가했다. 이전 정상 문서 digest는 유지됐고 실패 문서 write는 남지 않았다.
실제 remote constraint failure이며 mock 사전검증 실패로 대체하지 않았다. 운영 schema는 변경하지 않았다.

## 9. Immutable Artifact

40개 source hash는 고정된 이전 34개 baseline+승인된 modern 6개와 40/40 일치했다.
P6 승인 report의 전체 의미 digest와도 직접 비교한다.
datasetVersion, parserCommit, generatedAt, issuer/CIK, period, format, definitions, records, validation,
모든 provenance metadata/identity, expected counts/digests를 포함한다.
`backups/p75/artifact-<SHA256>.json`은 content-addressed 파일로 기존 파일 overwrite를 막는다.
`artifact.json`은 실행용 복사본이고 manifest가 양쪽 파일 SHA와 semantic SHA를 검증한다.
API key·token·이메일·로컬 Temp 경로·원본 PDF는 포함하지 않았다. artifact 약 12MB는 Git 제외 영속 백업 디렉터리에 있다.

예상/실제: definitions 14, values 950, provenance 1,344, validated 162, parsed 788.
artifact semantic digest:
`11ea4fcd71f7babc950abc91bfc0dd63b5ac8978a6f5494a8bd7449894f1eeb1`.

## 10. Artifact Determinism

같은 offline source cache·같은 parser commit으로 두 번 재파싱/생성, volatile metadata를 제외한 semantic digest 동일.
파일 SHA는 실제 bytes의 SHA256이며 JSON 문자열을 다시 인코딩한 hash와 혼동하지 않는다.
재다운로드·expected 재작성 없음.

## 11. Backfill Run1

concurrency=1, 40/40 성공. 최종 14/950/1,344와 manifest 일치.
초기 리허설의 verification은 같은 문서 재적재 비교였다. 이후 별도 강화 run에서 문서마다 **쓰기 후 실제 SELECT**로
정의·값·validation 근거·출처 metadata까지 40/40 대조했다. 후자의 verification writes는 0이다.
각 문서 delta/SQL/RPC/meta/latency는 보존된 `run-1.json`, `run-2.json`, `resume-results.json`에 기록했다.

## 12. Backfill Run2

동일 artifact 40/40 재실행, 논리 행 증가 0.
import 요청만 합산하면 RPC 400, rows_read 195,790, rows_written 1,424, D1 duration 323.24ms,
Worker wall 합계 73,482ms. 이는 CPU 시간이 아니다.

## 13. Remote Idempotency

Run1/Run2 counts·모든 semantic digest 동일. duplicate 0, conflict 0, orphan 0.
idempotent는 논리 데이터 중복 없음이며 과금/CPU가 0이라는 뜻은 아니다.

## 14. SQLite vs Remote

P6 SQLite A/B, remote Run1/Run2, 중간 실패 후 full rerun의 digest가 동일하다.
definitions `81a53c12…45e4ce9`, values `93176183…48d378`, provenance `cf2d670a…79974`.
combined:
`4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5`.

## 15. Query

기존 P6 query service를 실제 remote binding으로 실행했다. metric 순서는 FFO/AFFO/NFFO다.

| scope | 반환 건수 |
|---|---|
| Quarterly | 40 / 40 / 19 |
| Annual | 10 / 10 / 5 |
| YTD | 20 / 20 / 10 |

USD/share·diluted, 정의 경계·validation·복수 출처·primary period policy 유지.
standalone/YTD/FY 혼합 없음. response object만 private preview에서 생성했고 운영 public route는 열지 않았다.

## 16. Usage

최초/두 번째 **import 요청만**의 측정 결과:

| 항목 | Run1 | Run2 |
|---|---:|---:|
| SQL 시도 | 3,227 | 3,227 |
| D1 RPC | 400 | 400 |
| rows_read | 88,362 | 195,790 |
| rows_written | 6,990 | 1,424 |
| D1 duration ms 합계 | 356.52 | 323.24 |
| Worker wall ms 합계 | 75,489 | 73,482 |

초기 본 리허설은 private HTTP 352회, RPC 2,015, SQL 시도 13,624,
반환 meta rows_read 626,118, rows_written 11,647였다. 추가 retry/resume/read-verification 시험은 HTTP 132회,
RPC 812, SQL 시도 3,877, meta rows_read 100,440, rows_written 7,134였다.
실패 batch의 meta 미반환 부분은 0이라고 단정하지 않는다. SQL 수는 시도한 statements이며 실패 후 실제 실행 수와 다를 수 있다.
CLI migration/cleanup/final 조회를 포함한 D1 24h 관측은 rows_read 747,576, rows_written 22,453이었다.
이는 analytics의 갱신 지연 가능성이 있는 별도 관측값이다.

이번 데이터 1회 import+즉시 SELECT의 후보 예산은 대략 read 10만 이하/write 7천대다.
Free 일일 5M read/100K write 한도에 데이터 비용은 여유가 있으나 기존 production 사용량은 별도 합산해야 한다.
[D1 요금 기준](https://developers.cloudflare.com/d1/platform/pricing/) 참고.
**remote CPU는 미확보(null)**. wall/SQL 대기 시간을 CPU로 변환하지 않았으며
[Workers Free CPU 기준](https://developers.cloudflare.com/workers/platform/limits/) 10ms 통과 판정은 보류한다.

## 17. Single-writer Lock 설계

전용 D1 lease table 방식 B를 선택했다. importer 전체 lock key + dataset identity + owner + expiry + renewal + monotonic fence + release.
기존 queue lease에는 이 fence/원자적 소유권 의미가 없어 재사용하지 않았다.
SQL DB 시각으로 batch 시작/끝을 확인하며, guard row 누락도 preflight에서 차단한다.
테스트 schema는 `p75_*`에만 있다. **[PRODUCTION SCHEMA CHANGE REQUIRED]**. 0019는 만들지 않았다.

## 18. Concurrent Import

동시에 두 lease acquisition을 시작해 1개만 획득했다.
강화 시험에서는 두 import도 동시에 시작해 winner만 write, loser는 store preflight 전에 lease denied.
두 writer가 동시에 검증 후 write로 진입하지 않았다.

## 19. Lease Loss / Fencing

A lease 500ms → 만료 → B takeover → fence 증가 → stale A의 실제 batch CHECK 거부 및 전체 rollback.
사전검증을 통과한 후 소유권이 바뀌는 상황을 보기 위해 시험에서 SQL guard까지 강제 진입했다.
renewal은 fence 유지, release는 owner/fence 일치 조건으로 검사했다.

## 20. Profile Writer Race

격리 DB에서 metadata를 바꾼 새 profile writer 이후 old metadata backfill을 실행했다.
transaction 안의 metadata CAS guard가 오래된 writer를 차단했고 현재 profile은 보존됐다. synthetic 변경은 복구했다.
이는 proof-of-concept다. **운영 scheduler·`/api/sync`·수동 backfill에 barrier가 연결됐다는 뜻은 아니다.**
운영 실행 때 세 writer 모두를 잠시 배제하거나 동일 coordination 계약을 구현해야 한다. 현재 scheduler는 변경하지 않았다.

## 21. Retry / Full Rerun

실제 remote 4번째 문서의 batch 실패 → 앞선 3개 유지 → clear 없이 전체 artifact rerun → P6 digest 동일.
remote commit 뒤 response 유실을 controller에서 합성 재현해 1회 backoff 재시도하고 duplicate 0을 확인했다.
실제 Cloudflare overload를 발생시켰다고 주장하지 않는다. bounded exponential backoff+jitter 최대 2회 재시도.
값/정의 충돌·hash mismatch·lease loss·constraint 의미 오류는 자동 재시도 금지 테스트 PASS.

## 22. GitHub Push Auto Deploy

Pages: Cloudflare API로 main/production enabled/모든 경로/출력 `.` 확인.
Worker: Builds API는 인증 scope 부족으로 403. computer-use로 로그인된 공식 설정 화면을 읽어
main, `npm install`, `npx wrangler deploy --config worker/wrangler.jsonc`, 모든 경로, non-production build enabled 확인.
조사된 계정 목록은 Pages 1개/Worker 1개. GitHub Actions는 syntax/test만 수행한다.
따라서 push는 두 운영 배포를 유발할 수 있어 이번에 하지 않았다. 설정 변경도 없다.

## 23. Production 최종 순서

현재는 실행 금지. 별도 계획 문서 `production-specialized-rollout-p75-plan.md`에 조건부 순서를 기록했다.
Free 실제 예산/CPU 검증 → lock/profile barrier 검토 → 자동배포 일시 정지 승인 → backup/digest →
0017/분류 → 0018/승인된 lock schema → 내부 artifact backfill/Run2 → Worker/API →
profile barrier 해제 → 별도 승인된 Pages/UI → 마지막 승인된 push/자동배포 복원.

## 24. 기존 Regression

기존 596개 유지. P3~P6 audit와 40개 offline parser, 950 values/1,344 provenance, 기존 query semantics 유지.
P6 재무/classification sentinel 전체 digest 불변. specialized import 중 격리 DB의 기존 financial/classification 의미 값 불변.
운영은 읽기 전용으로 10 companies/500 financial_metrics/5,223 provenance/0016까지를 재확인했다.
UI/financial calculation/parser expected/기존 migration/scheduler/production config 변경 0.

## 25. Test

최종 `npm test`: **603 PASS / 0 FAIL**(기존 596 + 신규 7).
`npm run check`, `npm run p75:check`, `git diff --check`: PASS.
specialized/ historical/ inventory/ full-historical/ definition-review/ modern/ storage audits: PASS.
단 CPU와 실제 Free 제한 적용은 검증 미완료 항목이며 테스트 수치로 숨기지 않는다.

## 26. 수정 파일

- `worker/src/specialized-metric-store.js`: bulk preflight만 변경.
- `package.json`: 명시적인 P7.5 명령 추가.
- `scripts/p75-*`: artifact/check, 격리 config/migration, private Worker, meta 계측, lease/fencing,
  read verification, retry/resume, 설정 read-only/Secret 검사 도구.
- `tests/p75-rehearsal.test.js`: 신규 7개.
- 이 report, `realty-income-phase-p75-results.json`, `production-specialized-rollout-p75-plan.md`.
- generated artifact·manifest·문서별 결과·원본 계측 로그는 Git 제외 `backups/p75/`에 보존.

## 27. Production 변경

production migration/DB write/Worker deploy/Pages deploy/backfill/restore/Cron/Secret 변경 모두 **NO**.
GitHub push/local commit도 **NO**. private preview upload는 운영 script/version deploy가 아니다.
read-only production SELECT 결과의 rows_written=0, changed_db=false를 확인했다.

## 28. Disposable DB 상태

정상 최종 10 classification/14 definitions/950 values/1,344 sources를 보존한다.
사용된 private preview process는 종료한다. public route·Cron·운영 Secret은 연결하지 않았다.
검토 기록 보존 후 다음 승인된 단계에서 이 disposable DB만 삭제할 수 있다. 이번에는 삭제하지 않았다.

## 29. 발견 문제

- private preview의 실제 Free invocation 예산 적용 및 remote CPU 수치 미확보.
- 원본 store 51번 순차 조회는 여유/latency가 부족해 bulk 2번으로 개선.
- 운영 전용 lock schema와 모든 profile writer barrier는 추가 승인/구현 필요.
- initial verification이 재적재였으므로 이후 실제 read-only SELECT 검증으로 강화했다.
- artifact 경로 검사의 URL 오탐, 테스트 helper bind/async 오류, audit 잘못된 인수는 수정/재실행했다.
- invalid CHECK probe 후 Wrangler/Node Windows 종료 오류가 있었지만 API의 SQL 거부 및 이후 DB digest 정상은 확인됐다.
- secrets/이메일/cache/PDF/QA 이미지가 Git 변경 대상에 포함되지 않았으며 검사 PASS.

## 30. 최종 판정

**B. 호출구조/lock/store의 운영 연결과 실측 예산 검증에 추가 보완 필요.**
데이터 일관성은 통과했지만 A(운영 실행 가능)는 아니다. 실제 Free 부적합을 입증한 것이 아니므로 C로도 단정하지 않는다.

| 마지막 확인 | YES/NO |
|---|---|
| 1. 실제 remote 0017/0018 검증 | YES |
| 2. 실제 Free query 제한 적용까지 계측/검증 | NO — 호출 수는 계측, 제한 적용은 미확인 |
| 3. 실제 remote 99-statement batch | YES |
| 4. remote atomic rollback | YES |
| 5. immutable artifact 재현 | YES |
| 6. remote Run2 idempotency | YES |
| 7. SQLite/remote semantic 동일 | YES |
| 8. single-writer race 해결 | YES — 격리 시험, 운영 연결은 미실행 |
| 9. push 자동배포 영향 확인 | YES |
| 10. Production rollout 시작 가능 | NO |
