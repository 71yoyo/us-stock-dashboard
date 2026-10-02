# REIT Metrics R6I — Compact Incremental CPU Optimization

## 결론 / Production Readiness

판정 **B — 추가 최적화 필요**. D1 읽기 병목은 해결했지만 Free CPU gate는 실패했다. Production 변경, commit, push는 하지 않았다.

기준 HEAD는 `e8979c6f2faf9f4f62da78b72397531734dd6402`이다. 기존 full-history 경로/큐/UI는 변경하지 않았다. 새 compact 모듈은 HTTP/스케줄러에 연결하지 않은 내부 후보 경로이며 기본 false flag를 유지한다. Historical importer는 구현하지 않았다.

## 병목 원인

R6H review SQL은 `sec_standard_raw_metrics m JOIN json_each(?) j ... WHERE m.ticker=?`였다. 기존 ticker 전체 raw를 바깥 loop로 읽은 뒤 각 행마다 JSON 후보를 순회했다. 전체 DB full scan이 아니라 **ticker 범위 index scan + 후보 JSON 반복 scan**이다.

실제 격리 D1에서 이 쿼리만 실행해 확보한 수치는 다음과 같다. SQL meta이며 Worker CPU로 대체하지 않는다.

| 종목 | 기존 review rows_read | PK 강제 순회 review rows_read | 검토 후보 수 | 기존 SQL duration | 변경 SQL duration |
|---|---:|---:|---:|---:|---:|
| O | 63,376 | 96 | 5 | 462.8281ms | 1.0525ms |
| MSFT | 48,200 | 66 | 4 | 179.5334ms | 0.5594ms |

R6H invocation 전체 읽기 O 68,486 / MSFT 53,008의 대부분을 이 review가 설명한다. candidate parse, extractor, source hash/serialization은 Worker 비용이므로 위 SQL duration 차이를 CPU 절감량이라고 해석하지 않는다.

## Query Plan

로컬 실제 SQLite와 격리 D1 모두 동일한 plan을 확인했다.

기존:

```text
SEARCH m USING INDEX idx_sec_standard_raw_period (ticker=?)
SCAN j VIRTUAL TABLE INDEX 1:
```

변경:

```text
SCAN j VIRTUAL TABLE INDEX 1:
SEARCH m USING INDEX sqlite_autoindex_sec_standard_raw_metrics_1
  (ticker=? AND metric_name=? AND period_type=? AND period_start=? AND period_end=?)
```

`json_each`를 먼저 순회하도록 CROSS JOIN하고 후보 identity 전체로 기존 복합 PK를 탐색한다. row-by-row SELECT는 도입하지 않았다.

basis/unit/entity scope는 `STANDARD_RAW_METRICS`의 고정 정의와 store validation에서 검증한다. basic/diluted shares는 다른 metric identity다. 출처/계산 의미는 기존 source fingerprint 및 append-only provenance에 분리되어 있으며 값 PK에 새로운 임의 dimension을 혼합하지 않는다.

## 수정 구조

- compact 입력의 모든 fact가 동일 accession인지 검사한다. 최신 공시 직접/비교기간과 동일 accession 파생 입력만 extractor에 전달한다. full CompanyFacts 입력으로 되돌아가지 않는다.
- available 후보의 identity/값만 작은 JSON으로 projection해 한 번의 indexed review query를 실행한다. 실제 최종 Worker review 읽기는 O 73 / MSFT 38이다.
- 새 accession에서는 사용하지 않던 registry count/source-gap subquery를 제거했다. 동일 완료 accession shortcut에는 count/source-gap 검사를 계속 수행한다.
- store에 opt-in `preserveExisting`을 추가했다. 기존 기본값은 false이며 기존 UPSERT 계약을 유지한다. compact에서는 기존 raw 값 DO NOTHING, 모든 available provenance append를 유지한다.
- compact provenance SHA-256 계산은 독립 작업을 Promise.all로 처리한다. hash 입력/출력 및 검증 의미는 그대로다. validation/duplicate 검사를 완료한 후 batch를 만든다.
- registry claim, lease/fence guard, values/provenance/checkpoint 원자 batch, 실패 backoff, raw-only retry를 유지한다.
- pending review이면 이전 성공 accession을 보존한다. 검토 후보를 완료 상태로 자동 승격하지 않는다.

CPU 단계별 profiler는 이번에 추가하지 않았다. R6H에서 확보한 전체 경로 비용 분해와 실제 R6I CPU를 사용하며, 이번 결과만으로 hash/parse 등의 정확한 CPU 비율을 주장하지 않는다.

## Index / Migration

0022: **NO**. 기존 복합 PK로 필요한 indexed lookup이 가능하다. 새 index/write amplification 없음. 0001~0021, Production 설정, 기존 financial 계산은 변경하지 않았다.

## Missing Row 정책

O 67 raw / 44 available / 23 missing, MSFT 49 / 21 / 28을 그대로 유지한다. 기존 missing을 삭제하거나 review를 생략하지 않았다.

동일 missing은 provenance가 없으므로 원래도 source hash를 만들지 않는다. compact store의 DO NOTHING으로 기존 raw 갱신을 막되 신규 missing identity는 계속 저장한다. 동일 missing 후보를 개별 query로 확인하거나 추가 skip하는 최적화는 이번에 구현하지 않았다.

## Semantic Regression

R6H reference harness와 최적화 모듈을 같은 과거 seed에서 실행해 raw 전체 필드(비교에서 wall-clock 생성 timestamp만 제외), available 값, missing/needs_review, source fingerprint, provenance 필드/refs, accession을 deep equality로 대조했다.

| 항목 | O | MSFT |
|---|---:|---:|
| 의미 동등성 | PASS | PASS |
| 입력 raw | 67 | 49 |
| available | 44 | 21 |
| missing | 23 | 28 |
| needs_review | 0 | 0 |
| NULL 해소 review | 5 | 4 |
| 기존 available 값 correction | 0 | 0 |
| 실행 후 raw | 953 | 977 |
| 실행 후 provenance | 733 | 422 |
| 신규 raw identity | 21 | 13 |
| 신규 provenance | 44 | 21 |
| 실제 DEI 날짜 | 2026-07-30 | 2026-07-23 |

MSFT raw 977은 full snapshot 969와 동일한 horizon이 아니다. 과거 snapshot 보존 + R6H compact 후보의 추가 missing identity를 그대로 재현한 결과다. R6I는 이 기존 후보 의미를 임의로 바꾸거나 완전한 full snapshot 동등성으로 과장하지 않는다.

## Local Tests

기존 806개 유지 + 신규 20개. 최종 전체 826 PASS / 0 FAIL / 0 SKIP.

신규 검증: indexed plan, compact accession/배열 guard, DEI/missing, hash/출처 parity, same/new accession, NULL 해소 및 available 정정 보류, 실패 atomic rollback/retry, checkpoint rollback, lease/fence 소유권, 기본 false, duplicate 입력 차단, provenance gap shortcut 방지/복구, 새 accession과 기존 backoff 분리.

`npm test`, `npm run check`(r3/r5/r6i check 포함), `r3:audit`, `r5:audit`, `r6i:audit`, `git diff --check`: PASS.

R6I actual-candidate audit는 기존 Git 제외 R6F/R6H 입력과 reference harness에 의존한다. 원문/cache를 repo에 추가하지 않는다. 이 자료가 없는 checkout에서는 한국어 안내로 안전 중단하며 자동 다운로드하지 않는다. 일반 synthetic unit tests는 이 cache 없이 실행 가능하다.

## Cloudflare CPU Before / After

Before: O 12ms / MSFT 8ms, R6H 각 1회였으므로 통계적 안정성이 입증된 값이 아니었다.

After: 같은 Worker version `c8d53a2f-30d5-4204-b069-b235c32e5132`, compatibility date 2026-09-21, 동일 승인 격리 D1. 각 후보 후 과거 raw/provenance baseline을 정확히 복구해 초기 증분끼리 비교했다. 재시도/성공 표본 선별 없음. HTTP 200 / outcome ok / exception 없음 10/10. CPU는 실제 Cloudflare invocation telemetry 10/10 requestId+version 매칭이며 local elapsed를 사용하지 않았다.

| 종목 | 회차 | CPU ms | wall ms | D1 calls | SQL statements | rows_read | rows_written | isolate sequence |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| O | 1 | 44 | 1679 | 7 | 11 | 2632 | 202 | 1 |
| MSFT | 1 | 12 | 1357 | 7 | 11 | 2512 | 109 | 2 |
| O | 2 | 11 | 1327 | 7 | 11 | 2632 | 202 | 3 |
| MSFT | 2 | 9 | 1243 | 7 | 11 | 2512 | 109 | 4 |
| O | 3 | 13 | 1519 | 7 | 11 | 2632 | 202 | 5 |
| MSFT | 3 | 12 | 1353 | 7 | 11 | 2512 | 109 | 6 |
| O | 4 | 12 | 1318 | 7 | 11 | 2632 | 202 | 7 |
| MSFT | 4 | 11 | 1349 | 7 | 11 | 2512 | 109 | 8 |
| O | 5 | 13 | 1364 | 7 | 11 | 2632 | 202 | 9 |
| MSFT | 5 | 12 | 1244 | 7 | 11 | 2512 | 109 | 10 |

max O 44ms / MSFT 12ms / 전체 44ms. 평균/중앙값/p95는 제시하지 않는다. sequence 1은 isolate의 첫 관측 실행이며 2~10은 동일 isolate의 후속 실행이다. 실제 플랫폼 cold-start 비용의 독립 보장은 NOT VERIFIED이다. 첫 44ms를 제외하지 않으며 후속 O 11~13ms도 초과한다.

R6H 대비 D1 읽기 감소가 CPU 감소를 보장하지 않는다. 최종 CPU 수치는 오히려 R6H의 단일 표본보다 높다. 하네스는 statement별 D1 meta 기록도 추가했으며 표본/초기화/JIT 차이의 기여를 분리 측정하지 않았으므로 원인을 단정하지 않는다.

Free budget 10ms 및 안정 목표 max <=8ms 모두 FAIL. HTTP 200을 budget PASS로 대신하지 않는다. [Cloudflare Workers 제한](https://developers.cloudflare.com/workers/platform/limits/)

## D1 Before / After

| 종목 | R6H 전체 rows_read | R6I 전체 rows_read | 감소율 | R6H/R6I rows_written |
|---|---:|---:|---:|---:|
| O | 68,486 | 2,632 | 약 96.16% | 202 / 202 |
| MSFT | 53,008 | 2,512 | 약 95.26% | 109 / 109 |

최종 쿼리별 읽기:

| 단계 | O | MSFT |
|---|---:|---:|
| schema 2회 | 196 | 196 |
| registry insert/state/claim | 5 | 5 |
| indexed review | 73 | 38 |
| batch fence guard insert/delete | 2 | 2 |
| raw store | 335 | 245 |
| provenance store | 111 | 70 |
| checkpoint counts | 1,910 | 1,956 |

이제 checkpoint count가 주된 D1 read다. source/fencing/provenance 정확성을 약화시키지 않고 더 줄일 방법은 다음 단계에서 별도 검토해야 한다. rows_written은 D1 meta이며 raw 행 개수와 같지 않다.

## D1 일일 비용

계정 하루 analytics read-only 요청 1회: HTTP 200, VERIFIED. 2026-10-02 UTC 조회 시점 rowsRead 2,574,658 / rowsWritten 79,757. 집계값이며 실시간 확정 잔여량·이후 다른 workload를 보장하지 않는다.

10종목 운영의 실제 하루 filing 빈도는 이번에 관측하지 않았다. 예시로 신규 filing 1건이 있는 날은 측정한 O/MSFT 각각 2,632/2,512 read 및 202/109 write이다. 두 건이 모두 발생하면 5,144 read / 311 write이다. 이것은 수집 실행 비용만이며 UI/기타 앱/관리자 테스트/cleanup 비용을 포함하지 않는다. 연간 추정이나 매일 10종목 전부 공시한다는 가정은 하지 않는다.

## Correction / Review 및 기존 Regression

NULL→available O 5 / MSFT 4 보류, 원본 출처 append, 이전 성공 accession 보존, 기존 available overwrite 금지 모두 불변이다. 실제 두 후보에 available value correction은 0이며, 별도 synthetic correction 테스트로 보류 정책을 확인했다.

기존 R5 실제 10종목 cache 재검증: financial 500행 모든 컬럼/숫자 불변, classification 불변, financial provenance 불변, raw 9,062 / provenance 4,615, Run2 semantic/logical change 0, retention 285/285 복구 유지, DEI 실제 날짜 보존. EBIT/EBITDA strict optional sparse 유지, Total Debt/EV 구현 없음.

기존 외부 역사 문서 cache도 read-only 재사용해 O specialized 14 / 950 / 1,344와 combined digest `4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5` 불변을 확인했다.

## Cleanup

임시 Worker 삭제 후 공식 settings GET 404: PASS. 두 test namespace의 rows 삭제: PASS. protected rehearsal 39 table의 count/전체 row digest 및 O specialized digest 불변. Worker 임시 config 삭제. 기존 사용자 credential 및 원문 cache/PDF는 삭제·변경하지 않았다.

기존 P5B historical audit 재실행 과정에서는 외부 cache의 파생 `dry-run-results.json` / `dry-run-summary.json`이 재생성된다. 이는 기존 도구의 결과 기록 동작이며 원문 PDF/SEC cache를 변경하거나 다시 다운로드한 것은 아니다. 이 파일은 Git 대상에 포함하지 않았다.

## 수정 파일 / Git

- `worker/src/sec-standard-raw-incremental.js`
- `worker/src/sec-standard-raw-store.js`
- `tests/sec-standard-raw-incremental.test.js`
- `scripts/sec-standard-raw-incremental-audit.mjs`
- `package.json`
- `docs/reit-metrics-r6i-report.md`

실제 측정/SQL plan/검증 통계는 Git 제외 `backups/r6i`에만 있다. Secret/API key/token/email/.env/.dev.vars/원문/cache/PDF/SQLite snapshot은 추적 대상에 추가하지 않았다. Secret 검사 대상 6개 파일에서 실제 민감정보 포함 NO, staged files 0을 확인했다. migration 0001~0021/Production config/UI/API/큐 변경 없음.

Git: 위 6개 파일 미커밋. commit NO / push NO. Production migration/write/backfill/deploy/Pages/flag/Cron/Secret 변경 모두 NO. SEC/BQ/FMP/Massive 신규 호출 각각 0.

## 최종 YES/NO

1. full CompanyFacts Worker 입력 제거 방향 유지: YES
2. 높은 rows_read 원인 실제 특정: YES
3. 의미 변경 없이 query 최적화: YES
4. correction/restatement/review 정책 유지: YES
5. O/MSFT semantic equality: YES
6. Cloudflare 각 최소 5회 측정: YES
7. 모든 실제 CPU <=10ms: **NO**
8. duplicate/orphan 0: YES
9. 기존 financial/O specialized 불변: YES
10. Production 변경 없이 readiness 판정: YES

## 다음 단계

CPU 예산의 안정적 여유가 아직 없다. 이번 쿼리 최적화는 보존 가치가 있지만 승인 전 운영 연결하지 않는다. 추가 경로별 CPU/JIT 초기화/검증·출처 serialization/hash 비용을 더 분리하고 compact raw를 더 작은 작업 단위로 실행할지 검토하는 별도 Phase가 필요하다. 정확도 저하로 합격시키거나 첫 실행 표본을 버리지 않는다.
