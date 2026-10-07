# R11B-2-CI-HERMETIC-RESUME 보고서

## 판정

**A. HERMETIC SOURCE CI FIX READY FOR CHECKPOINT**

새 clean checkout과 로컬 모두 1274 PASS / 0 FAIL / 0 SKIP이다. 실제 GitHub Actions는 실행하지 않았으며, 아래 판정은 로컬 Node 24 clean-runner 재현 결과다.

## 시작 상태와 중단 변경 감사

HEAD 및 로컬 `origin/main`은 `ed9d6b3d30d243bd791bc1e7d9004467fa632d7e`다. 기존 CI-FIX 3개와 추가 6개, 합계 9개의 controlled changes로 시작했다. 출처 불명 파일은 0개다. reset/restore/clean/stash 폐기 없이 diff 전체와 비추적 helper/report를 읽었다. sanitized 요약은 Git ignored `backups/r11b2-ci-hermetic-resume/starting-summary.json`에 보존했다.

| 시작 파일 | 판정 | 근거 |
|---|---|---|
| `.github/workflows/verify.yml` | KEEP | 승인된 install → check → test 순서 |
| `scripts/sec-raw-production-check.mjs` | MODIFY | 정확한 CI/helper/audit/report 경로만 추가; 보호 검사 유지 |
| `docs/reit-metrics-r11b2-ci-fix-report.md` | KEEP | 이전 실패 보고서를 역사적 기록으로 보존 |
| `scripts/sec-raw-identity-audit.mjs` | MODIFY | 실제 evidence reader 분리 및 기존 집계/validator 계약 강제 |
| `tests/helpers/sec-raw-identity-fixtures.js` | KEEP | 명시적 합성 factory와 deterministic identity |
| `tests/helpers/sec-raw-identity-private-evidence.js` | KEEP | 기존 실제 reader를 별도 audit에 보존; 원문 복사 없음 |
| `tests/sec-raw-producer-identity.test.js` | MODIFY | 다른 hash namespace 사례 연결, exact count와 compat assertion 복구, 합성 시각 고정 |
| `tests/sec-raw-production-runner.test.js` | MODIFY | 합성 10종목 runner 계약 유지; 기준 시각 고정 |
| `tests/sec-standard-raw-runtime.test.js` | MODIFY | skip 제거와 합성 저장/retention/Run2 교차 검증 보강 |

REVERT는 0개다. 기존 구현을 처음부터 재작성하지 않았다. clean 실행에서 드러난 비결정적 시각 문제 때문에 telemetry 테스트 1개와, 기존 실제 audit 계약을 보존하기 위한 runtime audit 1개를 추가 수정했다. 이번 보고서까지 최종 controlled changes는 12개다.

## Clean runner 실패와 전체 private dependency inventory

최초 중단 candidate를 새 임시 clone에 반영한 결과: install PASS, check PASS, 1274 tests 중 1272 PASS / 2 FAIL / 0 SKIP.

| 테스트 파일/이름 | missing artifact | 실제 원인 | 분류 |
|---|---|---|---|
| `tests/sec-raw-producer-identity.test.js` / wire applicationIdentity와 journal key는 호환된 별도 namespace | 없음 | 동일 legacy/canonical hash fixture를 서로 달라야 하는 사례에 연결 | CORE DETERMINISTIC |
| `tests/sec-raw-telemetry.test.js` / ON/OFF processing parity와 추가 D1 query 0 | 없음 | 두 DB의 기본 cached_at이 초 경계에서 달라짐 | ALGORITHM REGRESSION |

기존 CI-FIX의 private artifact 실패도 이번 inventory에 포함했다. `tests/`, 관련 helpers 및 import되는 scripts의 backups/cache/CompanyFacts/readFile/process.cwd 참조를 조사했다.

| 경로/소비자 | 검증하던 계약 | 최종 처리 |
|---|---|---|
| R4 acquisition 및 10종목 CompanyFacts cache → identity fixture → producer identity/runner 테스트 | V1/V2 identity, 정렬 안정성, correction, compat, journal, consumer 저장 | 일반 테스트는 합성 factory로 1:1 전환 |
| R9D production-baseline, R10A production-read → identity fixture | 실제 운영 checkpoint 재현 | private evidence helper 및 `r10c2:audit`에만 보존 |
| R4 results/inspection/SQLite snapshot → runtime audit | 실제 285 retention, 500 financial, flow 및 Run2 | `r5:audit`에서 exact 검증; CI에는 합성 10종목 교차 검증 |
| private specialized/architecture/promotion/telemetry/incremental audit scripts | 실제 과거 실행 evidence | 기존 별도 audit 범위 유지; 일반 npm test에서 실행하지 않음 |
| scheduled producer CLI 테스트의 backups/r10b 임시 하위 폴더 | 합성 CLI I/O 계약 | 테스트가 직접 생성·제거하는 합성 입력; 기존 private 자료 의존 아님 |
| repo tests/fixtures, docs 결과, migrations, frontend, Git HEAD 비교 | 기존 parser/UI/schema 회귀 | Git 추적 자료 그대로 사용 |
| node_modules/wrangler/config-schema.json | 배포 설정 구조 | 승인된 install로 공급; private 의존 아님 |

UNKNOWN 분류는 0개다. 핵심/알고리즘 검증은 CI에 유지하며, 실제 evidence 감사 2개만 분리했다. 첫 실패에서 멈추지 않고 전체 npm test 결과를 수집했다. 이어진 candidate는 tests 1274 PASS였지만 Secret guard가 기존 합성 credential 표기를 차단해 check FAIL이었다. 해당 테스트 marker를 명시적 synthetic prefix로 수정했고 보호 검사 자체는 약화하지 않았다.

## 수정 전략과 fixture

합성 ticker/CIK/accession, 간단한 산술 값, 12개 row를 만드는 factory를 사용한다. 실제 SEC 응답이나 기업 수치를 새 fixture에 복사하지 않았다. 10개 사례의 identity 동일 2개/정렬 차이 8개, 12개 shuffle, true correction, unresolved journal, compat, validator, 실제 SQLite 저장/duplicate/rollover 의미를 유지한다.

합성 validator는 130 records / available 50 / missing 80 / needs_review 0을 exact 검사한다. 실제 AAPL validator 67건 계약은 private identity audit에서 계속 강제한다. 합성 공시 기준 시각을 고정하고 disposable SQLite의 Julian-day 시계도 동일하게 맞췄다. lease guard SQL을 제거하거나 우회하지 않는다. telemetry 비교는 DB 초기 cached_at만 고정하며 기존 snapshot 및 SQL/call-count 비교를 그대로 유지한다.

R5 CI replacement는 합성 10종목, financial 500행, 10FY/40Q period-end available 2000건, 종목별 DEI 60일, flow deep equality, registry 10, duplicate/orphan 0, Run2 values/provenance/registry deep equality 및 logical write/batch 0을 검증한다. 기존 retry/rollback/lease 실패 테스트도 모두 유지한다. private audit 입력 부재는 ENOENT rejection으로 검증하며 PASS/skip으로 숨기지 않는다.

## 별도 private audits

기존 명령을 그대로 사용한다. package.json은 변경하지 않았다.

- `npm run r10c2:audit`: 실제 10종목 hash/CIK/checkpoint, AAPL V1/V2 exact identity 및 validator 67, semantic equality, 2 동일/8 정렬 차이, fake INTENT 및 publish 0.
- `npm run r5:audit`: 실제 10종목 승인 hash, retention 285/285, financial 500행, flow 불변, registry 10, duplicate/orphan 0, Run2 logical/registry 변경 0.

기존 로컬 evidence로 두 함수를 실행해 모두 PASS했다. SEC/BQ/FMP/Massive 및 기타 외부 호출은 0이다. fresh Production 검증으로 보고하지 않는다. 실제 evidence/숫자 원문은 보고서나 새 fixture에 저장하지 않았다. 자료 없는 clean checkout에서는 두 CLI 모두 exit 1을 확인했으며 silent PASS가 없다.

## 검증 결과

| 검증 | 최종 clean checkout | 로컬 working tree |
|---|---|---|
| `npm install --no-package-lock` | PASS | 기존 설치 사용 |
| `npm run check` | PASS | PASS |
| `npm test` | 1274 PASS / 0 FAIL / 0 SKIP | 1274 PASS / 0 FAIL / 0 SKIP |
| package-lock 생성 | 0 | 추적 lockfile 0 |
| 설치 전 node_modules/private 입력 | 0 / 0 | 로컬 자료를 CI에 복사하지 않음 |
| private audit 입력 부재 | 두 CLI 모두 exit 1 | 실제 자료 감사 PASS |
| Wrangler | 4.136.1 | 4.136.1 |
| `npm run build:pages` | 이번 clean 단계 대상 아님 | PASS |
| Pages artifact | 로컬 build에서 별도 확인 | 10 exact / unexpected 0 / 소스 byte exact 10 |
| `git diff --check` | check 내부 PASS | PASS |

최종 clean 검증은 UTC 2026-10-06 17:13:33~17:14:51에 실행했다. `.pages-dist` 자체는 generated ignored 산출물로 남으며 stage하지 않았다. 임시 clone은 제거했고 최종 evidence 집계는 ignored `backups/r11b2-ci-hermetic-resume/final.json`, 로컬 집계는 같은 경로의 `local-validation.json`이다. 중간 실패 기록은 삭제하지 않았다.

clean runner는 매번 새 임시 Git clone을 만들고 현재 controlled changes만 반영한다. node_modules, backups, cache, 실제 환경파일, private evidence를 복사하지 않으며 credential 관련 환경변수도 전달하지 않는다. 기존 `.env.example`은 추적된 템플릿이지 Secret이 아니다. npm install의 패키지 다운로드만 허용하며 Production/SEC API 검증은 실행하지 않는다. 임시 checkout은 절대 경로와 임시 부모 디렉터리를 검증한 뒤 제거한다.

## Coverage

before: 1274. 순수 core/regression 테스트 삭제: 0. 실제 evidence 감사 2개의 일반 테스트 등록은 동일 product logic의 deterministic replacement 2개로 대체했다. 별도 실제 audit 구현/의미는 유지하고 필요한 exact assertion은 전용 audit 안으로 이동했다. 등록 수는 1274 - 2 + 2 = 1274이며, after: 1274 PASS / 0 FAIL / 0 SKIP. test.skip, 환경별 제외, artifact 없음 PASS, continue-on-error, assertion 약화는 없다.

## 최종 변경 파일

1. `.github/workflows/verify.yml`
2. `scripts/sec-raw-production-check.mjs`
3. `docs/reit-metrics-r11b2-ci-fix-report.md`
4. `scripts/sec-raw-identity-audit.mjs`
5. `scripts/sec-standard-raw-runtime-audit.mjs`
6. `tests/helpers/sec-raw-identity-fixtures.js`
7. `tests/helpers/sec-raw-identity-private-evidence.js`
8. `tests/sec-raw-producer-identity.test.js`
9. `tests/sec-raw-production-runner.test.js`
10. `tests/sec-raw-telemetry.test.js`
11. `tests/sec-standard-raw-runtime.test.js`
12. `docs/reit-metrics-r11b2-ci-hermetic-report.md`

## 보안·Production·Git

실제 Secret/API key/token/PAT/이메일/contact, 환경파일, credential hash/prefix/length, 실제 CompanyFacts/SEC body/재무 raw, private backup evidence, SQLite/PDF/cache 포함 0. 기존 보호 검사와 추가 diff 검토로 확인한다. 합성 identity hash는 알고리즘 expected이며 credential hash가 아니다. 새 .pages-dist와 ignored 작업 evidence는 stage하지 않는다.

frontend 10개, Worker runtime/config, Consumer, SEC producer runtime, migrations 변경 0. Production mutation, deploy, DB write, Queue publish, Cron/Secret 변경, SEC 호출, GitHub Actions 실제 실행 모두 0. Production 상태를 새로 조회하거나 수정하지 않았다.

HEAD/origin-main 불변. stage 0, commit NO, push NO. 작업 트리는 의도된 12개 controlled changes가 남는 미커밋 상태이며 clean이라고 표시하지 않는다.

다음 단계는 `R11B-2-CI-HERMETIC-CHECKPOINT`다. 이번 작업에서는 자동 commit/push/deploy하지 않는다.

## 마지막 YES/NO

1. HEAD ed9d6b exact? YES
2. 중단 partial changes 먼저 감사? YES
3. reset/clean으로 무작정 삭제하지 않음? YES
4. 기존 CI-FIX 3개 보존? YES
5. 일반 npm test의 private artifact dependency inventory 완료? YES
6. failing tests 분류 완료? YES
7. blind skip 0? YES
8. private backup commit 0? YES
9. real CompanyFacts cache commit 0? YES
10. 신규 CI fixtures synthetic only? YES
11. core semantics preserved? YES
12. production audit 의미 preserved? YES
13. clean install PASS? YES
14. clean check PASS? YES
15. clean test PASS? YES
16. skips 0? YES
17. coverage 약화 0? YES
18. Wrangler 4.136.1 유지? YES
19. Pages artifact 10 exact? YES
20. Worker runtime changes 0? YES
21. migration changes 0? YES
22. secret leakage 0? YES
23. Production mutation 0? YES
24. push 0? YES
25. controlled changes only? YES
26. HERMETIC SOURCE CI FIX READY FOR CHECKPOINT? YES
