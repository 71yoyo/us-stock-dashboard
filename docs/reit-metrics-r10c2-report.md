# R10C-2 — Producer Identity Compatibility / Legacy Bridge

## 목적과 변경 범위

승인 parent: `428bdbd3d2b205a88d2f6bcb670ec63f57ceeadd`.
동일 compact 의미가 fact 배열 정렬 때문에 correction으로 오인되는 문제를 producer-side bridge로 해결한다.
SEC/Cloudflare/GitHub 실제 요청, Production 쓰기/배포/설정 변경, commit/push는 하지 않는다.
검증 evidence는 `backups/r10c2`의 Git ignored 영역에 저장한다. 원문/재무 값/credential은 report에 저장하지 않는다.

## Identity code audit

| identity | 실제 생성 경로 | hash 입력/순서 | 현재 의미 |
| --- | --- | --- | --- |
| legacy compact source V1 | `buildCompactSecRawMessage` → `rawSourceIdentity(rawMessageSource(...))` | version/ticker/accession/filing/facts/financialPeriods; 객체 key 재귀 정렬, 배열 순서 유지 | 기존 Production checkpoint 재현 |
| canonical compact source V2 | `orderedCompactSource` → 위 기존 builder | V1의 같은 입력; fact 배열만 canonical row text의 `localeCompare(...,'en')`으로 정렬 | R10B 생성 의미 그대로 |
| consumer wire application V1 | message `idempotencyKey` | `sec-raw:<sourceIdentity>` 문자열 | consumer validator/telemetry가 요구하는 기존 형식 |
| producer journal application V1 | `producerJournalIdentityV1` / 기존 `applicationIdentity` 별칭 | SHA-256(canonical({ticker,accession,sourceIdentity,schemaVersion})); schemaVersion 기본 1 | R10B journal key 알고리즘 불변 |
| consumer source 재검증 | `validateCompactSecRawMessage` | 전달된 V2 message 배열 순서 유지하여 V1 wire hash 재계산 | Node가 정렬한 배열을 보내므로 V2와 동일 hash |
| compact DB checkpoint | consumer → `runRawRecordRuntime` | 검증한 message sourceIdentity를 channel=compact에 저장 | producer bridge가 rewrite하지 않음 |
| journal 완료 | `reconcile` | accession/sourceIdentity/schemaVersion exact checkpoint 또는 review 증거 | bridge 판단으로 완료를 위조하지 않음 |
| historical source | `importHistoricalSecRaw` / promotion 검증 | {version:1,ticker,accession,cik,facts,financialPeriods}; 전체 CompanyFacts facts, 원래 배열 순서 | channel=historical; compact와 별도 identity |

compact 선택에는 승인 tag/unit만 포함하며 같은 accession의 비차원 fact만 사용한다.
row field는 start/end/val/form/fp/fy/filed/accn/frame/entityScope를 그대로 보존한다.
financialPeriods는 선택 fact의 실제 end가 있는 annual/quarterly anchor만 원래 입력 순서로 보존한다.
enqueuedAt/Queue messageId/전송 attempt는 sourceIdentity 입력이 아니다.
V2가 정렬하는 대상은 fact 배열뿐이며 financialPeriods 순서를 임의 변경하지 않는다.

### Application identity 명칭 정리

R9E/R9F의 applicationIdentity는 consumer wire의 `sec-raw:<sourceIdentity>`였다.
R10C-1의 별도 SHA-256 applicationIdentity는 R10B producer journal key였다.
동일 필드명으로 서로 다른 namespace를 보고한 것이며 wire 형식이 변경된 것은 아니다.
이번에는 `consumerApplicationIdentityV1`과 `producerJournalIdentityV1`을 명시적으로 분리했다.
기존 export `applicationIdentity`와 저장된 journal key/state는 그대로 읽힌다. wire message에 journal hash를 넣지 않는다.

## Version contract

- source algorithm: V2; legacy 비교: V1; message schema: 1; journal application algorithm: 1.
- 새 policy fixture는 `identityAlgorithmVersion:2`를 명시한다. 이 field도 policyManifestHash 입력이다.
- 해당 field가 없는 기존 policyVersion=1의 R10B policy는 원래부터 V2였으므로 V2로 읽는다. 원래 manifest/hash를 수정하지 않는다.
- 명시된 1/3/null 등 미지원 algorithm은 fail-closed로 거부한다.
- readiness receipt와 run summary에 사용 algorithm을 명시한다. DB checkpoint의 미기재 알고리즘을 추정해서 기록하지 않는다.
- journal key의 알고리즘은 기존 V1이며 source V1/V2는 입력 sourceIdentity로 구분된다. journal state/schema migration은 없다.

## Bridge decision rules

1. 같은 accession/schema의 checkpoint hash가 V2와 같으면 `UNCHANGED`.
2. V2와 다르지만 원래 배열의 V1 hash가 checkpoint와 정확히 같고, compact 모든 field 및 추출 records/출처가 exact하면 `UNCHANGED_COMPAT`.
3. 같은 accession에서 둘 다 불일치하거나 의미가 달라지면 `CORRECTION_CANDIDATE`.
4. accession이 다르면 `NEW_SOURCE`. 미색인이면 기존 `SOURCE_NOT_INDEXED` 지연 정책 유지.

`UNCHANGED_COMPAT`은 publish decision만 SKIP한다. Production checkpoint rewrite, V2 INTENT/COMPLETED, journal completion 생성은 0이다.
V1 hash를 역산하거나 임의 permutation을 검색해 일치시키지 않는다. 재수신 순서가 달라 V1 exact hash를 증명할 수 없으면 bridge로 숨기지 않는다.
신규 source가 consumer에서 정상 완료될 때에만 그 source의 V2 hash가 정상 checkpoint로 저장되어 자연 rollover한다.

## Journal safety

기존 unresolved INTENT/ACCEPTED/AMBIGUOUS/OPERATOR_REQUIRED는 bridge 판단보다 먼저 검사한다.
canonical key가 없을 때만, 원본 V1 hash 및 exact semantic 증거로 legacy journal 별칭을 조회한다.
V1 REVIEW_BLOCKED/COMPLETED_RECONCILED를 새 V2 INTENT로 복제하지 않는다. 완료/review 상태의 기존 exact 증거 조건은 약화하지 않는다.
raw payload/financial values/credential은 journal, run summary에 포함하지 않는다.

## AAPL 및 MSFT

AAPL accession: `0000320193-26-000020`.
V1: `88012b7063102e8bacedd70d042b441422241350e6bc347517d45ddf3cca9def`
V2: `7e1312cd69b64b79f47ac1062c4c4f4356e553052e0d3c0ca07706b3b5cf33c6`
67 records 및 모든 compact 의미 exact. 운영 V1 fixture → `UNCHANGED_COMPAT`, publish/INTENT/correction candidate 0.

MSFT accession: `0001193125-26-323660`.
V1=V2: `47aaee9626d08aa12e9143ecc1005d763d811929bc851d87a83ed3b919da9cbc`
의미 exact, 운영 checkpoint fixture → `UNCHANGED`, publish 0.
Production checkpoint 증거는 기존 R10A metadata를 재사용했다. fresh Production 조회가 아니다.

## 승인 10종목 offline audit

| ticker | V1/V2 비교 | semantic equality |
| --- | --- | --- |
| NVDA | ORDER_NORMALIZATION_ONLY | PASS |
| GOOGL | ORDER_NORMALIZATION_ONLY | PASS |
| AAPL | ORDER_NORMALIZATION_ONLY | PASS |
| TSLA | ORDER_NORMALIZATION_ONLY | PASS |
| MSFT | SAME_IDENTITY | PASS |
| AMZN | ORDER_NORMALIZATION_ONLY | PASS |
| O | ORDER_NORMALIZATION_ONLY | PASS |
| JPM | ORDER_NORMALIZATION_ONLY | PASS |
| ABBV | ORDER_NORMALIZATION_ONLY | PASS |
| ABT | SAME_IDENTITY | PASS |

same identity 2 / normalized-only 8 / actual semantic differences 0.
실제 원문은 기존 승인 SHA-256과 CIK를 확인하고 메모리에서만 사용한다.

## Tests 및 regression

시작 기존 전체 테스트: 1099 PASS / 0 FAIL / 0 SKIP.
신규 28개: identity exact, 10종목 의미 비교, 12 permutation, true correction/value/filed/fp, 새 accession,
legacy ACCEPTED/AMBIGUOUS/REVIEW_BLOCKED, wire/journal namespace, 현재 consumer initial/duplicate/natural rollover,
정책 버전/null 거부, schema mismatch, fake completion/원문 누출/소스 불변 보호.
기존 consumer 및 validator를 disposable 메모리 SQLite에서 사용한다. 외부 D1 write가 아니다.

전체 3회 연속 `npm test`: 매회 **1127 PASS / 0 FAIL / 0 SKIP**. 기존 1099개 + 신규 28개 유지.
`npm run check`, `r10b:check`, `r10b:audit`, `r10c2:check`, `r10c2:audit`, `git diff --check`: PASS.
R3/R5/R6I/R7/R8B/R8I-FIX/R9D-TEL offline audit도 PASS.
R10C-1 최초 exit 1 원인은 아직 미확정이며, 3회 통과하더라도 과거 실패 원인을 해결했다고 판정하지 않는다.

regression 재검증: historical raw/provenance/missing/review **9062 / 4615 / 4422 / 25**, retention **285/285**,
Run2 logical/semantic change 0, 기존 financial 500행 및 classification 불변.
O specialized **14 / 950 / 1344**, combined digest:
`4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5` 불변.
특수 문서 원본 PDF 재파싱은 기존 외부 cache 불완전으로 수행하지 않았으며, 기존 승인 artifact를 이용한 DB round-trip/digest를 R8B/R8I-FIX에서 재검증했다.
최종 evidence에서 기존 R3 audit가 반환한 불필요한 sample 숫자 26개 field를 제거했다. cache/DB 원문을 삭제하거나 수정한 것은 아니다.

## 변경 파일

`scripts/sec-raw-producer-identity.mjs`, `scripts/sec-raw-source-discovery.mjs`, `scripts/sec-raw-scheduled-producer.mjs`,
`scripts/sec-raw-automation-policy.mjs`, `scripts/sec-raw-automation-readiness.mjs`, `scripts/sec-raw-producer-journal.mjs`,
`scripts/sec-raw-automation-check.mjs`, `scripts/sec-raw-identity-check.mjs`, `scripts/sec-raw-identity-audit.mjs`,
`tests/helpers/sec-raw-automation-fixtures.js`, `tests/helpers/sec-raw-identity-fixtures.js`, `tests/sec-raw-producer-identity.test.js`,
`package.json`, 본 보고서. 총 14개 controlled 파일.

## 운영 및 Git

SEC live fetch/Queue publish/Production D1 write/deploy/Queue config/Cron/Secret/token/GitHub/migration: ALL NO.
기존 consumer/historical/financial/classification/UI 및 migration 0001~0022는 불변이다.
commit/push NO. Git은 R10C-2 controlled changes only이며 checkpoint를 아직 만들지 않는다.

## Verdict / Next step

**A. IDENTITY COMPATIBILITY READY FOR CHECKPOINT**.
다음 credential/state backend gate는 이번 작업에서 자동 실행하지 않는다.
이번 결과는 로컬 compatibility readiness이며 Production rollout/publish 승인은 아니다.

## 마지막 YES/NO

1. V1 identity exact 재현: YES
2. V2 canonical identity stable: YES
3. AAPL false correction 제거: YES
4. MSFT compatibility PASS: YES
5. 10 ticker semantic audit PASS: YES
6. ordering-only 차이 정확히 분류: YES
7. true correction 계속 탐지: YES
8. new accession 계속 탐지: YES
9. applicationIdentity 호환성 확정: YES
10. current consumer V2 message 처리 가능: YES
11. V2 duplicate no-op: YES
12. V1→V2 자연 rollover 가능: YES
13. Production checkpoint rewrite 0: YES
14. migration 0: YES
15. npm test 3회 연속 PASS: YES
16. Production 변경 0: YES
17. Git controlled changes only: YES
18. 다음 credential/state backend gate 준비 진행 가능: YES
