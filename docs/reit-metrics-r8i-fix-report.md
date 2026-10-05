# R8I-FIX — 공식 historical mutation planner

## 판정

A. READY FOR CHECKPOINT. 운영 rollout 승인이 아니라 코드 checkpoint 준비 완료 판정이다.

시작 HEAD는 `607f93f2d7d7a2dbdb5684cf63db77987fdaf4be`, Git clean이었다. 시작 921 PASS / 0 FAIL / 0 SKIP와 지정된 모든 check/audit가 통과했다. commit/push는 실행하지 않았다.

## 원인과 공통 설계

기존 official dry-run은 shared verification 직후 조기 반환하여 aggregate counts/estimate만 제공했다. 실제 apply의 runtime/lease/store/checkpoint 계획은 없었다.

`prepareHistoricalMutationPlan`의 동일 `prepareCore`를 dry-run과 apply에 사용한다. 공통 완료/integrity 판정, review SQL, claim 조건, checkpoint 허용 조건을 기존 runtime과 공유한다. 저장 계획은 기존 store와 동일한 fingerprint와 raw identity를 사용한다.

- dry-run: 기존 promotion verification → read-only planner → `summary`/`perTickerPlans`; write adapter 호출 없음.
- apply: 기존 enable/target/envelope/fresh receipt pair/checkpoint guard → 같은 planner → 기존 lease claim → 같은 core 재확인 → 기존 atomic store/runtime executor.
- executor는 검증된 계획의 내부 고정 records를 직접 소비한다. 공개 JSON 복제·변경·다른 DB 실행을 거부한다. 공개 dry-run 계획은 write DB에 직접 실행할 수 없다.
- claim 이후 다른 source가 저장된 경우 현재 DB를 다시 비교하여 review 상태를 계산한다. lease/fence 검증과 원자 batch를 유지한다.
- 계획 실패 시 dry-run PASS receipt와 부분 성공 계획을 반환하지 않는다.
- verify-only의 기존 승인·evidence semantics는 변경하지 않는다.

원문/값/SQL bind는 내부 WeakMap 사본에만 존재한다. 공개 계획에는 dataset/source identity, schema/data version, counts, review/status/checkpoint/runtime/action 요약만 포함한다. 별도 registry table은 만들지 않으며 기존 `sec_raw_runtime`의 status transition을 registry 의미로 표현한다. `registry.statusUpdate`는 runtime completion과 같은 변경이므로 write estimate에서 중복 계산하지 않는다.

승인 envelope 없는 기존 offline dry-run은 DB 호출이 필요 없는 기존 contract를 유지한다. 그 계획에는 `stateVerified:false`가 명시되며 운영/기존 DB 상태 검증으로 인정하지 않는다.

## 실제 approved cache 감사

새 provider 호출 0. 기존 R4 cache 10종목만 사용했다. 원문/SQLite/실행 결과는 Git 제외 경로에 두고 repo fixture로 추가하지 않았다. 감사 중 전역 fetch를 차단했다. 감사에는 로컬 합성 envelope/대상만 사용했고 실제 운영 envelope는 적용·재검증·수정하지 않았다. Secret 검사에서만 실제 대상 ID의 변경 파일 포함 여부를 값 비공개 상태로 비교했다.

| 종목 | raw | provenance | missing | needs_review | Run1 결과 |
| --- | ---: | ---: | ---: | ---: | --- |
| NVDA | 974 | 404 | 570 | 0 | ready |
| AAPL | 977 | 443 | 534 | 0 | ready |
| MSFT | 969 | 405 | 564 | 0 | ready |
| JPM | 769 | 356 | 413 | 0 | ready |
| O | 953 | 709 | 238 | 6 | pending_review |
| ABBV | 983 | 493 | 490 | 0 | ready |
| ABT | 780 | 437 | 338 | 5 | pending_review |
| AMZN | 969 | 484 | 485 | 0 | ready |
| GOOGL | 714 | 308 | 406 | 0 | ready |
| TSLA | 974 | 576 | 384 | 14 | pending_review |
| 합계 | 9,062 | 4,615 | 4,422 | 25 | checkpoint 10/10 |

Review 종목의 실제 runtime은 `pending`을 유지한다. source processed는 YES지만 all metrics reviewed는 NO다. NULL 자동 해소·기존 available overwrite·correction 자동 승격 없음. historical checkpoint는 review 완료와 별개로 저장된다.

Run1 보수적 상한은 43,031, 계획상 의미적 writes는 13,737이다. 후자는 raw 9,062 + provenance 4,615 + 10종목 × 6(runtime 초기 생성/claim/completion, checkpoint, guard insert/delete)이다. disposable SQLite 논리적 변경 13,737과 일치한다. **실제 Cloudflare D1 과금 rows_written/CPU는 이번에 측정하지 않았다.** 50,000 승인 상한 이내라는 사전 계산이며 fresh quota gate를 대체하지 않는다.

Run2: 10종목 모두 completed same source shortcut. raw/provenance/checkpoint/registry/runtime 의미적 변경과 실제 로컬 실행 변경은 모두 0, batch 0. 보수적 상한은 dataset 규모를 나타내므로 43,031을 유지하고 의미적 writes는 0으로 구분한다. O/ABT/TSLA review pending도 그대로 유지한다.

Same accession + changed sourceIdentity는 shortcut하지 않는다. 비교/검토/재처리 후 historical checkpoint를 갱신하며 기존 값을 보존하고 provenance를 append한다. New accession은 새 provenance와 checkpoint를 처리한다. provenance gap이 있으면 동일 source라도 shortcut 대신 복구한다.

## Apply parity / regression

Reference는 위 승인 checkpoint의 실제 runtime/store를 `git show`로 읽어 사용했다. import URL만 치환했으며 reference 로직이나 expected 값을 재작성하지 않았다.

10종목 reference apply와 planner/executor apply의 raw 전 필드·provenance·runtime 상태/버전/fence/attempt·review·checkpoint·fingerprint/accession이 의미적으로 완전히 일치한다. 비교에서 wall-clock timestamp와 일회성 lease 값만 제외했다. 성공 후 lease/guard/backoff 잔존 0도 별도로 확인했다. duplicate/orphan 0, retention 285/285, DEI 실제 날짜 386건 보존.

기존 financial 500행과 합성 LMT 50행을 포함한 11-company 보호 digest 불변. O specialized 14/950/1,344와 combined digest `4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5` 불변. classification/UI/public API 불변. R6I compact의 추가 planner 조회 없음, R7 Queue 경계/기본 OFF와 R8B 승인 격리 유지. Total Debt/Net Debt/EV/EV-EBITDA 미구현 유지.

## 검증

기존 921 + 신규 23 = 944 PASS / 0 FAIL / 0 SKIP.

`npm run check`, r3/r5/r6i/r7/r8b의 check/audit, `r8i-fix:check`, `r8i-fix:audit`, `git diff --check` 모두 PASS.

신규 검증은 공식 출력, 쓰기 차단, 10/10 checkpoint, 25 review, Run2 no-op, changed/new source, action 수, runtime/backoff/lease, reference parity, budget, malformed/scope/guard/leakage, immutable plan, claim 후 재확인, provenance gap, rollback, 실패 receipt 차단을 포함한다.

## 변경 파일

- `package.json`
- `scripts/sec-raw-historical-import.mjs`
- `scripts/sec-raw-historical-plan.mjs`
- `scripts/sec-raw-historical-plan-check.mjs`
- `scripts/sec-raw-historical-plan-audit.mjs`
- `worker/src/sec-standard-raw-incremental.js`
- `worker/src/sec-standard-raw-store.js`
- `tests/sec-raw-historical-plan.test.js`
- `tests/helpers/sec-raw-historical-reference.js`
- `docs/reit-metrics-r8i-fix-report.md`

## 경계 / 다음 단계

새 migration 없음. 0001~0022와 운영 설정 불변. 실제 Secret/credential/email/운영 identity/원문/cache/SQLite/evidence를 변경 파일에 포함하지 않았다. 감사 로그와 상세 계획은 Git 제외 경로에만 저장했다.

Production DB write/migration/historical apply/remote verify/remote dry-run/Queue publish·binding/Worker·Pages deploy/flag/Cron/Secret 변경 **전부 NO**. 원격 운영 상태를 다시 조회하지 않았으며 과거 운영 snapshot을 이번에 새 검증한 것처럼 주장하지 않는다.

HEAD 불변. Git은 이 Phase 관련 10파일만 변경된 미커밋 상태다. commit NO / push NO.

기존 R8D envelope는 기존 checkpoint에 묶여 있으므로 미래 새 checkpoint에 사용할 수 없다. 이번에는 기존 envelope 수정/새 envelope 발급을 하지 않았다. 다음은 별도 승인에 따라 checkpoint → backup/restore → 새 envelope → fresh quota/verify-only/dry-run의 운영 R8I 재검증이다. R8J/apply로 자동 진행하지 않는다.

## 마지막 YES/NO

1. 공식 dry-run 실제 mutation plan: YES
2. apply와 동일 planning core: YES
3. dry-run write 0: YES
4. Run1 checkpoint 10/10: YES
5. needs_review 25 보존: YES
6. O/ABT/TSLA review 보존: YES
7. Run2 완전 no-op: YES
8. changed identity shortcut 금지: YES
9. estimated writes <=50,000: YES
10. apply semantic parity: YES
11. migration 추가 없음: YES
12. 기존 financial/O specialized 불변: YES
13. Production 변경 0: YES
14. Secret/raw/cache 포함 0: YES
15. READY FOR CHECKPOINT: YES
