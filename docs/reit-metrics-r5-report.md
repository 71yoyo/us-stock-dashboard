# REIT Metrics R5 — SEC Raw Foundation Production Safety Fix

## 1. 시작 상태

기준 HEAD: `b2e60543b1baed7410d8ea70dcaa06a0c6aad236`.
시작 Git clean, 기존 776 PASS / 0 FAIL, check/r3:check/r3:audit/diff-check PASS.
이번 단계는 구현/로컬 검증만이며 commit/push/운영 변경은 하지 않았다.

## 2. Raw Runtime State 설계

`sec_raw_runtime`은 기존 `fundamental_jobs`/`sec_filing_checks`와 분리된다.
schema version 1, data version 2, pending/running/ready/error, 마지막 성공 accession/시각,
안전한 오류 메시지, 독립 retry 시간, 시도 accession/version/count, 임대 token/만료/fence,
완료 record/available 수를 저장한다. 오류가 나도 마지막 성공 checkpoint는 보존한다.

완료 판단은 accession/version/status와 raw 행 수/현재 provenance의 존재 여부를 함께 확인한다.
schema preflight를 큐 시작 전에 수행한다. 공개 API/화면 contract에는 registry를 추가하지 않았다.

## 3. Migration 0021

`0021_sec_standard_raw_runtime.sql`은 registry/인덱스/임시 batch guard/검증 trigger만 추가한다.
기존 table DROP/ALTER/수치 UPDATE는 없다. 0001~0020 수정 0.
Fresh 0001~0021, Existing 0020→0021, FK 검사 PASS. 운영 migration NO.

## 4. Initial Backfill Guard

동일 accession/metadataVersion=1의 기존 완료 financial job에서도 내부 raw-only 경로를 검사한다.
raw 미완료이면 기존 legacy 숫자를 다시 계산/저장하지 않고 CompanyFacts 한 응답으로 처리한다.
raw 완료이면 CompanyFacts 공급자를 호출하지 않고 unchanged로 종료한다.

## 5. Raw Retry

raw 실패는 raw registry에만 error와 15분 뒤 retry를 기록한다.
legacy ready/오류/실행일/공시 checkpoint를 raw-only retry가 덮어쓰지 않는다.
legacy 다음 실행일이 미래여도 raw due 종목은 별도 큐 후보로 처리한다.
공시 목록 조회 장애도 raw-only retry로 분리했다.
DB 자체 장애로 오류 기록이 불가능하면 성공 처리하지 않으며 미완료/임대 만료 후 재처리한다.

## 6. Instant Retention Fix

재무 시점 창, 기존 10FY/40Q의 보호 대상 end, DEI 실제 날짜 창을 합집합으로 보존한다.
DEI는 독립 60개 실제 날짜 창이며 분기 말로 옮기지 않는다.
보호 기간에 직접 적격 fact가 없으면 명시적 NULL을 남긴다.

- R4 lost 고유 후보: 285.
- available로 복구: 285/285.
- 해당 285개 중 실제 missing: 0.
- 해당 285개 중 잔여 semantic limitation: 0.
- 전체 보호 대상 고유 조합: 2,000, available 1,636, missing 364, needs_review 0, row absent 0.
- annual/quarterly 중복 end를 각각 세면 2,500개 조합 중 2,048 available / 452 missing.
- 실제 날짜/provenance를 보존한 DEI 출처: 386건.

364개 missing은 기존 엄격한 직접 매핑/원문 적격성에 따른 NULL이다. 다른 태그의 값을 억지로 채우지 않았다.
연간/분기 중복 end 때문에 285 고유 조합 복구는 표시 기간 기준 370건 증가에 해당한다.

## 7. 실제 10종목 Coverage 전후

아래 시점 coverage는 5개 point metric × (10 annual + 40 quarterly)의 250개 표시 기간 조합이다.
annual과 quarter의 같은 end를 각각 센 값이며 raw 고유 row 수가 아니다.

| 종목 | R4 available / 250 | R5 available / 250 | EBIT 연간 available / 10 | EBITDA 연간 available / 10 |
|---|---:|---:|---:|---:|
| NVDA | 125 | 170 | 0 | 0 |
| AAPL | 148 | 200 | 0 | 0 |
| MSFT | 152 | 200 | 0 | 0 |
| JPM | 162 | 162 | 0 | 0 |
| O | 185 | 249 | 10 | 10 |
| ABBV | 148 | 191 | 8 | 0 |
| ABT | 230 | 230 | 4 | 0 |
| AMZN | 148 | 200 | 0 | 0 |
| GOOGL | 200 | 200 | 0 | 0 |
| TSLA | 180 | 246 | 6 | 0 |

| 지표 | Annual 전→후 / 100 | Quarterly 전→후 / 400 |
|---|---:|---:|
| Shares Outstanding | 63→80 | 266→320 |
| Cash & Equivalents | 73→93 | 298→368 |
| Assets | 80→100 | 329→400 |
| Parent Equity | 80→100 | 329→400 |
| Equity+NCI | 31→39 | 129→148 |

flow는 R4와 값/출처 deep equality PASS. flow 분모는 실제 raw start/end 조합으로,
Quarterly 359, YTD 210이며 기존 financial 400Q와 동일 분모가 아니다.
EBIT 28/100, 76/359, 59/210; EBITDA 10/100, 32/359, 25/210으로 그대로다.
기본/희석 평균 주식 수는 각각 94/100, 297/359이며 YTD 210개는 정책상 NULL이다.

## 8. EBIT/EBITDA 정책

**A — strict optional sparse metric** 선택.
ProfitLoss/Tax/Interest/D&A의 기간·USD·연결 범위·전체 source accession 일치 정책을 유지했다.
NetIncomeLoss, InterestExpenseNonoperating, 다른 D&A 태그는 추가하지 않았다.
Total Debt/Net Debt/EV 신규 구현 0. B 설계/자동 확장은 이번 범위에 포함하지 않는다.

## 9. Disposable Storage

R4 10종목 원문 SHA-256/CIK를 대조했고 신규 금융 API 호출은 0이다.
R4 baseline SQLite도 읽기 전용으로 열며 새 결과 DB는 메모리에서만 만든다.

| 항목 | R4 | R5 Run1 |
|---|---:|---:|
| raw values | 8,187 | 9,062 |
| provenance / available | 4,183 | 4,615 |
| missing | 3,979 | 4,422 |
| needs_review | 25 | 25 |
| duplicate / orphan | 0 / 0 | 0 / 0 |

registry 10행, 임시 guard 잔존 0행.
NULL 수 증가에는 독립 DEI 날짜의 비주식 point 지표와 보호 기간의 명시적 미확보가 포함된다.
SQLite page 크기 증가 7,987,200 bytes는 로컬 저장 크기이며 D1 과금 크기로 보고하지 않는다.

## 10. Idempotency

Run2 semantic/logical change 0, registry 증가 0, raw/provenance duplicate/orphan 0.
CompanyFacts 재취득/공급자 호출 0. 완료된 ticker당 INSERT OR IGNORE + 상태 SELECT만 실행하며 실제 변경 0.
raw digest: `6921fb525b8987b99c537a420713adb948c2f4795b19e1a43b1b445bf818687a`.

## 11. Failure Matrix

| 케이스 | 확인 결과 |
|---|---|
| A legacy 미완료 / raw 미완료 | 동일 payload로 legacy/raw 완료; raw 장애여도 정상 legacy 반환 유지 |
| B legacy 완료 / raw 미완료 | raw-only 초기 처리; legacy SQL write 0 |
| C legacy 완료 / raw 성공 | unchanged; payload 공급자 호출 0 |
| D legacy 완료 / raw 실패 | legacy ready/숫자/checkpoint 유지, raw error/retry, lease 해제 |
| E 실패 후 retry 성공 | legacy 미래 next_run_at과 독립 실행; raw 오류/retry 해제 |
| F 동일 accession 재실행 | raw/registry 변경 0 |
| G 새 accession | 새 raw checkpoint/정정 provenance 보존, runtime-only 실행은 legacy 변경 0 |

추가: active lease 중복 claim 거부, stale fence/만료 lease 쓰기 차단, registry version 갱신,
raw/provenance 삭제 복구, 공시 미색인 safe-fail, SQL/registry/중간 chunk 실패 검증 PASS.
guard + values + provenance + 성공 checkpoint는 같은 transaction이다.
완료 registry UPDATE 실패도 전체 rollback하며 재시도는 idempotent다.
자료가 선행 저장되고 완료 기록 전 중단된 상태도 별도로 구성해 중복 없이 완료됨을 확인했다.

## 12. Query/Batch Cost

| 10종목 실행 | SQL statements | 로컬 binding individual / batch | 로컬 logical changes |
|---|---:|---:|---:|
| R4 raw + preflight | 88 | 기존 근거 | 12,370 |
| R5 raw-only Run1 + 공용 preflight | 150 | 42 / 10 | 13,727 |
| R5 raw-only Run2 | 20 | 20 / 0 | 0 |
| R4 legacy+raw | 648 | 기존 근거 | 23,316 |
| R5 legacy+raw | 728 | 60 / 30 | 24,673 |

registry 관련 Run1 SQL 60개, logical changes 50개(종목당 seed/claim/guard insert/완료/guard delete).
완료 상태 SELECT 10개이며 상태 조회 안의 집계/출처 join은 ticker 단위 인덱스를 이용한다.
raw-only에 재무 기간 조회 10개, 공용 schema 조회 2개, raw INSERT 78개가 더해진다.
raw 행마다 클라이언트 SELECT를 호출하는 N+1은 없다.
raw-only 최대 bind 374,955 bytes / 9개 parameters / SQL 1,498 bytes.
legacy 포함 최대 bind 474,855 bytes / 42개 parameters.
SQLite logical changes/로컬 binding 호출 수를 D1 rows_read/rows_written/quota로 환산하지 않는다.

## 13. D1 Quota

**NOT VERIFIED**. 기존 관리자 credential은 존재하지만 기존 disposable D1 identity GET이 HTTP 401을 반환했다.
인증 갱신/신규 token/원격 쓰기를 하지 않고 중단했다.
이전 검증이나 로컬 150/728 statements만으로 현재 Free quota PASS/FAIL을 판정하지 않았다.

[공식 D1 limits](https://developers.cloudflare.com/d1/platform/limits/)는 Free invocation 50 제한과
batch 내 개별 SQL 길이/bind 제한을 설명한다.
[공식 workerd binding 구현](https://github.com/cloudflare/workerd/blob/main/src/cloudflare/internal/d1-api.ts)의
batch는 SQL 배열을 한 번의 상위 binding 전송으로 묶는다. 이것만으로 현재 계정의 실제 quota 차감을 확정할 수는 없다.
[공식 D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)의 원자 실행과
[과금 규칙](https://developers.cloudflare.com/d1/platform/pricing/)의 실제 meta.rows_read/rows_written은 별도로 확인해야 한다.

비운영 검증 계획:

1. 기존 인증만 사용해 허용된 rehearsal DB의 ID/name과 production 미연결을 먼저 확인한다.
2. 기존 DB의 다른 테이블을 보존하고 raw 0020/0021 schema/전용 테스트 ticker를 준비한다.
3. 쓰기/외부 fetch 제한, 만료, 인증 guard를 갖춘 isolated preview에서 실제 R4 payload를 메모리로 받아 처리한다.
4. raw-only, legacy+raw, 최대 2 ticker 큐, Run2, failure/retry를 실제 Worker binding에서 실행한다.
5. invocation별 SQL 수와 binding 호출 수, 각 D1 meta, 오류/outcome을 따로 기록하고 50 boundary probe를 분리한다.
6. 관리자 REST 성공을 Worker invocation quota 검증으로 대체하지 않는다.
7. preview/ticker/test raw 자료만 정리하며 보호 테이블 digest 불변과 cleanup을 확인한다.

이 계획은 아직 실행하지 않았다. 불명확한 target이거나 인증 실패면 더 진행하지 않는다.

## 14. CPU

**NOT VERIFIED**. 관리자 인증 401로 isolated preview 생성/동일 실행의 CPU 관측이 불가능했다.
기존 Observability 파일은 존재하지만 값을 출력/변경하지 않았고 새 token도 만들지 않았다.
과거 specialized GET CPU 검증을 새 CompanyFacts parse/hash/write CPU 근거로 재사용하지 않았다.
로컬 elapsed를 Worker CPU로 표시하지 않았다.
후속 검증은 계정 Free 조건을 확인한 preview에서 큰 CompanyFacts/첫 처리/재시도/Run2를
분리해 실행하고, 기존 Observability token의 인증 성공 후 request ID별 실제 CPU/outcome을 수집해야 한다.

## 15. Existing Regression

기존 financial 500행 숫자/기간 의미 및 전체 행/출처 불변, classification 불변.
numeric digest: `2334fb2828cd476eefa653728fbbb25756dffd27c02577133a39074d31832331`.
O specialized: 14 definitions / 950 values / 1,344 provenance 유지.
digest: `4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5`.
UI/public route/응답 contract 및 기존 재무 계산/특수 parser expected 변경 0.
기존 776 테스트 수정/삭제/완화 0.

## 16. Raw Foundation Readiness

**NOT READY (Production 기준)**.
로컬 correctness/보존/초기 처리/retry/atomicity/idempotency gate는 PASS지만,
실제 Free CPU/D1 quota 미검증이 남아 있다. feature flag는 기본 false로 유지한다.

## 17. EBIT/EBITDA UI Readiness

**PARTIAL**. 엄격 정책에서 검증된 일부 회사/기간만 available이며 범용 UI enable은 NO.
raw 저장 안전성과 UI coverage를 서로 다른 축으로 판정한다.

## 18. Test

기존 776 + 신규 R5 30 = **806 PASS / 0 FAIL / 0 SKIP**.
npm test / npm run check / r3:check / r3:audit / r5:check / r5:audit / git diff --check PASS.
실제 캐시가 없는 다른 checkout에서 actual-cache unit test는 skip 가능하지만,
실제 audit 명령은 캐시 부재/hash 불일치 시 실패하며 실제 검증 PASS를 만들지 않는다.
이번 환경에서는 실제 10종목 캐시 검증과 O 외부 historical cache 검증 모두 실행했다.

## 19. 수정 파일

- worker/migrations/0021_sec_standard_raw_runtime.sql
- worker/src/sec-standard-raw-runtime.js
- worker/src/sec-standard-raw.js
- worker/src/sec-standard-raw-store.js
- worker/src/fmp-sync.js
- worker/src/fundamental-sync.js
- tests/sec-standard-raw-runtime.test.js
- tests/helpers/sec-standard-raw-runtime-db.js
- scripts/sec-standard-raw-runtime-audit.mjs
- package.json
- docs/reit-metrics-r5-report.md

전체 원문/cache/PDF/스크린샷/환경파일은 추적 대상에 추가하지 않았다.
실행 결과 JSON은 Git 제외 `backups/r5/results.json`에만 저장했다.
실제 API key/token/email/credential을 변경 파일에서 값 비교/패턴 검사하며 출력하지 않았다.

## 20. Production 변경

NO. migration/write/backfill/Worker deploy/Pages deploy/Cron/Secret/flag 활성화/push/commit 모두 NO.
Cloudflare 호출은 기존 disposable identity 읽기 전용 확인뿐이며 401 이후 중단했다.
SEC/BQ/FMP/Massive 신규 실제 호출 각각 0.

## 21. 발견 문제

실제 Free CPU/quota gate 미검증과 sparse coverage는 남는다.
현재 raw window가 이동해도 이미 저장한 raw/provenance history는 임의 삭제하지 않는다.
따라서 장기 운영 저장량/이력 정리 정책은 다음 승인 범위에서 별도 결정해야 한다.
DB 자체 장애로 raw 오류 기록이 실패하면 즉시 success로 표시할 수 없으며 임대 만료 후 다시 시도한다.

## 22. 다음 단계

사용자의 검토 후 별도 checkpoint 승인. 이어서 기존 인증 복구 및 격리 CPU/quota 실측을 진행한다.
그 전에는 Production migration/deploy/flag 활성화/backfill을 하지 않는다.

마지막 YES/NO:

1. legacy/raw 완료 상태 분리: YES.
2. 기존 완료 job 초기 raw 처리: YES.
3. raw-only retry: YES.
4. instant 공유 60-date 문제 해결: YES.
5. DEI 실제 날짜 보존: YES.
6. 실제 R4 cache regression PASS: YES.
7. EBIT/EBITDA 억지 확장 없음: YES.
8. raw atomicity/idempotency 유지: YES.
9. 기존 financial/O specialized 불변: YES.
10. Production raw rollout 준비 여부 명확 판정: YES — NOT READY.
