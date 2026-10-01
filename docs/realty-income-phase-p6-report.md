# Phase P6 — Disposable Historical Backfill / Idempotency / Query

## 1. 시작 상태

checkpoint `e8ca3b5818611b7f962907dcb6518ef64bf736ff`, Git clean에서 시작했다.
기존 543 PASS / 0 FAIL, check/diff 및 specialized/historical/inventory/definition-review/full-historical/modern audit PASS.
기존 repo 밖 cache만 사용하고 원문 재다운로드·외부 API 호출은 하지 않았다.

## 2. Disposable DB

Node.js `node:sqlite`의 독립 `:memory:` SQLite DB A/B를 사용했다.
실패/추가 출처 검증도 각각 별도의 메모리 DB에서 실행했다.
파일 경로는 두 DB 모두 `:memory:`이며 서로 다른 연결이다. 영속 파일 0개, 검증 종료 후 모든 DB 연결을 닫았다.
D1·공유 preview DB·기존 개발 DB·Worker 환경변수는 이 도구의 입력으로 받지 않는다.

최소 company O row는 DISPOSABLE TEST ONLY로 구분했고 sector/industry를 기존 classification 규칙에 전달했다.
Industry `REIT - Retail` → REIT, high confidence. ticker로 profile을 판정하지 않았다.

## 3. Migration

0001~0018 fresh migration 전체 PASS, foreign_keys=ON.
기존 migration 수정/새 migration 없음.
migration 내용 digest: `99960eb6a600222b3cc22f7c9d792d18cb1608e42566e3956f8bac5f0318773a`.

## 4. First Backfill

processed 40 / accepted 40.
definition 14 / value 950 / provenance 1344.
validated 162 / parsed 788. 모두 parser의 원래 상태 및 official expected 근거를 보존한다.
definition/값/출처 기대 row 수는 실제 parser 출력에서 동적으로 계산하며 모든 저장 필드 digest까지 대조했다.

| metric | quarterly | annual | ytd | 합계 |
| --- | ---: | ---: | ---: | ---: |
| AFFO | 230 | 58 | 119 | 407 |
| FFO | 182 | 46 | 91 | 319 |
| NORMALIZED_FFO | 124 | 32 | 68 | 224 |

이 수치는 비교 열/definition/basis까지 전량 포함한 저장 row 수다.
아래 40분기·10연도 series 수와 혼동하지 않는다.

## 5. Second Backfill

동일 40 source/동일 parser/동일 DB에 Run #2 완료.
definition 14 / value 950 / provenance 1344.
row 증가 NO. validation/definition/canonical/raw/provenance 의미 데이터 변경 없음.

## 6. Idempotency Digest

Run1: `4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5`
Run2: `4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5`
동일 YES.

- definitions: `81a53c12a7cf10a5be21b363a68b25d444b51e0f7c26d65347fca244d45e4ce9`
- values: `9317618347c475beb181048d2ceab40d69a8e4c47601a2092a524bf81e48d378`
- provenance: `cf2d670a173d10b5f9ee948918c484472e794e28b700fc9d1fd5bfc723479974`

SQL identity 순서 및 JSON 키를 정렬한다. retrieved_at/updated_at/created_at만 volatile 시각으로 제외한다.
raw/canonical 값·unit·basis·fiscal metadata·definition·validation·source hash·page·section·document 및 나머지 source metadata는 보존한다.

## 7. Duplicate

logical value 0 / provenance 0 / definition 0.
canonical identity와 source observation identity를 SQL GROUP BY로 검사했다.

## 8. Conflict Test

같은 record key의 synthetic 다른 숫자를 저장할 때 conflict로 거부하고 기존 전체 snapshot을 보존했다.
같은 definition identity의 내용 변조도 거부했다. 자동 overwrite 없음.

## 9. Additional Provenance Test

FY2025 SEC HTML / IR PDF 12/12 exact, difference/conflict 0.
B2의 source hash 및 정의/조정표 evidence가 승인된 equivalence view만 별도 메모리 DB에서 사용했다.
12 values / 12 SEC provenance → 12 values / 24 SEC+IR provenance.
동일 view 재실행 때 value/provenance 추가 0. 원본 version/validation은 출처 metadata로 보존한다.

기본 historical A/B의 14 definitions / 950 values / 1344 provenance는 이 테스트로 변경하지 않았다.
서로 다른 원본 definition의 자동 병합은 하지 않으며 실제 parser/store의 identity 정책도 변경하지 않았다.

## 10. Atomic Rollback

기존 DB.batch transaction을 그대로 사용한다. 문서 하나가 atomic 단위다.
앞선 FFO source insert가 실제 실행됐다는 SQL 조건을 확인한 뒤 NFFO provenance insert에 RAISE(ABORT)를 발생시켰다.
99 statements 문서 전체 rollback, 신규 definition/value/source 잔존 0, 먼저 적재한 정상 문서 snapshot 불변.
trigger 제거 후 같은 문서 정상 저장 PASS. 이 결과는 로컬 SQLite 검증이며 production D1 실행 검증은 아니다.

## 11. Quarterly Query

직접 공시기간 diluted/share series: FFO 40 / AFFO 40 / NFFO 19.
FFO/AFFO 2016-03-31 → 2025-12-31, NFFO 2021-06-30 → 2025-12-31.
오래된 → 최신 순, 미공시 기간을 0/보간/역산으로 생성하지 않는다.

## 12. Annual Query

FFO 10 / AFFO 10 / NFFO 5.
FFO/AFFO FY2016~FY2025, NFFO FY2021~FY2025.
미공시 FY2016~FY2020 NFFO는 빈 결과다.

## 13. YTD Query

FFO 20 / AFFO 20 / NFFO 10.
Q2의 6M와 Q3의 9M를 ytd scope로 조회한다.
각각 연초 시작, Q2/Q3 종료 기간을 반환한다. quarterly에 혼입하지 않는다.

## 14. Q4 / Annual 분리

2025 Q4 standalone 2025-10-01~2025-12-31과 FY2025 2025-01-01~2025-12-31을 별도 scope/key로 반환한다.
Q1은 quarterly만, Q4 annual은 FY이며 별도 YTD/Q4 복제 없음.
FY−YTD 차감 계산 없음.

## 15. Basis / Unit

common total / diluted total / basic/share / diluted/share를 엄격히 분리한다.
total canonical unit USD, per-share USD/share. query가 canonical value를 반환하므로 caller가 배율을 재적용하지 않는다.
rawValue/rawUnit/rawMultiplier 및 출처 unit measurement/qualifier를 함께 보존한다.
미공시 diluted total은 quarterly 7개 / annual 1개를 생성하지 않는다.
unit/date/basis/share/owner/version/attribution 필터는 SQL bind이며 start/end는 periodEnd 포함 범위다.

## 16. Definition Boundary

각 query row에 definitionOwner/definitionVersion/attributionBasis/validationStatus를 반환한다.
경계 요약은 정의 변경과 attribution만 변경된 경우를 구별한다. 같은 기간의 복수 정의도 숨기지 않는다.
원본 정의를 smoothing/자동 병합/경제적 동일 series로 간주하지 않으며 YoY/CAGR는 구현하지 않는다.

실제 quarterly 경계:

| metric / scope | 경계 기간 | 이전 definition | 이후 definition | 구분 |
| --- | --- | --- | --- | --- |
| AFFO / quarterly | 2017 Q3 | AFFO-FFO-REAL-ESTATE-V1 | AFFO-FFO-DEPRECIABLE-V1 | definition |
| AFFO / quarterly | 2017 Q4 | AFFO-FFO-DEPRECIABLE-V1 | AFFO-FFO-DEPRECIABLE-V1 | attribution |
| AFFO / quarterly | 2021 Q2 | AFFO-FFO-DEPRECIABLE-V1 | AFFO-NFFO-VEREIT-V1 | definition |
| AFFO / quarterly | 2021 Q4 | AFFO-NFFO-VEREIT-V1 | AFFO-NFFO-INTEGRATION-V1 | definition |
| AFFO / quarterly | 2023 Q4 | AFFO-NFFO-INTEGRATION-V1 | AFFO-NFFO-VEREIT-SPIRIT-V1 | definition |
| AFFO / quarterly | 2024 Q1 | AFFO-NFFO-VEREIT-SPIRIT-V1 | AFFO-NFFO-INTEGRATION-V1 | definition |
| AFFO / quarterly | 2024 Q3 | AFFO-NFFO-INTEGRATION-V1 | AFFO-NFFO-TRANSACTION-OTHER-V1 | definition |
| AFFO / quarterly | 2024 Q4 | AFFO-NFFO-TRANSACTION-OTHER-V1 | AFFO-NFFO-TRANSACTION-OTHER-NET-V1 | definition |
| NORMALIZED_FFO / quarterly | 2021 Q4 | NFFO-VEREIT-MERGER-V1 | NFFO-MERGER-INTEGRATION-V1 | definition |
| NORMALIZED_FFO / quarterly | 2023 Q4 | NFFO-MERGER-INTEGRATION-V1 | NFFO-MERGER-INTEGRATION-VEREIT-SPIRIT-V1 | definition |
| NORMALIZED_FFO / quarterly | 2024 Q1 | NFFO-MERGER-INTEGRATION-VEREIT-SPIRIT-V1 | NFFO-MERGER-INTEGRATION-V1 | definition |
| NORMALIZED_FFO / quarterly | 2024 Q3 | NFFO-MERGER-INTEGRATION-V1 | NFFO-MERGER-TRANSACTION-OTHER-V1 | definition |
| NORMALIZED_FFO / quarterly | 2024 Q4 | NFFO-MERGER-TRANSACTION-OTHER-V1 | NFFO-MERGER-TRANSACTION-OTHER-NET-V1 | definition |

실제 annual 경계:

| metric / scope | 경계 기간 | 이전 definition | 이후 definition | 구분 |
| --- | --- | --- | --- | --- |
| AFFO / annual | 2017 FY | AFFO-FFO-REAL-ESTATE-V1 | AFFO-FFO-DEPRECIABLE-V1 | definition |
| AFFO / annual | 2021 FY | AFFO-FFO-DEPRECIABLE-V1 | AFFO-NFFO-INTEGRATION-V1 | definition |
| AFFO / annual | 2023 FY | AFFO-NFFO-INTEGRATION-V1 | AFFO-NFFO-VEREIT-SPIRIT-V1 | definition |
| AFFO / annual | 2024 FY | AFFO-NFFO-VEREIT-SPIRIT-V1 | AFFO-NFFO-TRANSACTION-OTHER-NET-V1 | definition |
| NORMALIZED_FFO / annual | 2023 FY | NFFO-MERGER-INTEGRATION-V1 | NFFO-MERGER-INTEGRATION-VEREIT-SPIRIT-V1 | definition |
| NORMALIZED_FFO / annual | 2024 FY | NFFO-MERGER-INTEGRATION-VEREIT-SPIRIT-V1 | NFFO-MERGER-TRANSACTION-OTHER-NET-V1 | definition |

실제 YTD 경계:

| metric / scope | 경계 기간 | 이전 definition | 이후 definition | 구분 |
| --- | --- | --- | --- | --- |
| AFFO / ytd | 2017 Q3 | AFFO-FFO-REAL-ESTATE-V1 | AFFO-FFO-DEPRECIABLE-V1 | definition |
| AFFO / ytd | 2018 Q2 | AFFO-FFO-DEPRECIABLE-V1 | AFFO-FFO-DEPRECIABLE-V1 | attribution |
| AFFO / ytd | 2021 Q2 | AFFO-FFO-DEPRECIABLE-V1 | AFFO-NFFO-VEREIT-V1 | definition |
| AFFO / ytd | 2022 Q2 | AFFO-NFFO-VEREIT-V1 | AFFO-NFFO-INTEGRATION-V1 | definition |
| AFFO / ytd | 2024 Q3 | AFFO-NFFO-INTEGRATION-V1 | AFFO-NFFO-TRANSACTION-OTHER-V1 | definition |
| AFFO / ytd | 2025 Q2 | AFFO-NFFO-TRANSACTION-OTHER-V1 | AFFO-NFFO-TRANSACTION-OTHER-NET-V1 | definition |
| NORMALIZED_FFO / ytd | 2022 Q2 | NFFO-VEREIT-MERGER-V1 | NFFO-MERGER-INTEGRATION-V1 | definition |
| NORMALIZED_FFO / ytd | 2024 Q3 | NFFO-MERGER-INTEGRATION-V1 | NFFO-MERGER-TRANSACTION-OTHER-V1 | definition |
| NORMALIZED_FFO / ytd | 2025 Q2 | NFFO-MERGER-TRANSACTION-OTHER-V1 | NFFO-MERGER-TRANSACTION-OTHER-NET-V1 | definition |

2017 quarterly의 attribution 변경은 definition version 변경과 구별한다.
2023 Q4 → 2024 Q1의 version 이동도 승인된 원문별 정의 그대로이며 이를 재정의해 평탄화하지 않는다.

## 17. Recommended API Contract

권장: `GET /api/companies/O/specialized-metrics?metric=AFFO&scope=quarterly&basis=per_share&shareBasis=diluted`.
optional: start/end/unit/definitionOwner/definitionVersion/attributionBasis/includeComparisons.
HTTP route는 아직 구현/연결/배포하지 않았다. 독립 query service만 구현했다.
향후 route는 기존 PIN/API 인증 정책 및 pagination/response 크기·D1 비용을 검토한 다음 연결한다.

응답 개념:

```json
{
  "ticker": "O",
  "metric": "AFFO",
  "scope": "quarterly",
  "basis": "per_share",
  "shareBasis": "diluted",
  "sourcePolicy": "primary_period_disclosure",
  "dateFilter": "periodEnd inclusive",
  "data": [],
  "definitionBoundaries": [],
  "economicContinuityAssumed": false
}
```

data는 fiscalYear/fiscalPeriod/periodStart/periodEnd/value/unit/definitionOwner/definitionVersion/
attributionBasis/validationStatus 및 최소 provenance summary를 포함한다.

기본은 source fiscal metadata가 해당 value 기간을 직접 공시한 값만 반환한다.
다음 연도의 비교 열은 DB에 모두 보존하며 includeComparisons=true일 때 별도로 반환한다.
같은 기간의 다른 definition을 최신값으로 자동 덮어쓰거나 하나로 합치지 않는다.
source fiscal metadata가 없는 경우 기본 series의 직접 공시값이라고 추정하지 않는다.

## 18. DB A / DB B Rebuild

두 독립 DB 모두 fresh 0001~0018 → 같은 40 source 적재.
counts 14 / 950 / 1344, definitions/values/provenance digest 각각 일치.
종합 digest `4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5`, same YES.
기존 DB를 삭제하지 않고 새 DB B로 재구축했으며 모든 연결을 닫아 폐기했다.

## 19. Existing Data Regression

disposable sentinel financial_metrics 및 산업 규칙으로 만든 company_classification의 전체 row digest가
각 DB의 backfill 전후 불변이다. 운영 DB 데이터를 복사하거나 비교한 것이 아니다.
원래 저장/분류 모듈도 수정하지 않았다.

## 20. Parser Regression

외부 cache 전체를 B2 승인된 audit 경로로 재파싱, source hash 40/40 확인.
기존 34개 deep equality PASS, 40/40 안전 파싱,
VERIFIED_PARSED 9 / PARSED 31 / NEEDS_REVIEW 0 / UNKNOWN_FORMAT 0.
1344 observations / 950 unique parser values / 1344 provenance /
comparison exact 394 / difference 0 / conflict 0 / restatement 0 유지.
P6 전후 parser output hash 불변. 기존 expected/definition/parser 코드 변경 없음.

## 21. Test

기존 543 + 신규 53 = 596 PASS / 0 FAIL.
npm run check / git diff --check PASS.
기존 specialized/historical/inventory/definition-review/full-historical/modern audit 및 P6 storage audit PASS.
로컬 CI는 최소 fixture, 실제 audit는 기존 외부 source cache를 사용한다.

## 22. 수정 파일

- worker/src/specialized-metric-query.js: 순수 저장 조회/조건 검증/definition·attribution 경계.
- scripts/specialized-disposable-db.mjs: 메모리 DB/최소 회사·분류/sentinel/digest/중복 검사.
- scripts/specialized-historical-backfill.mjs: 문서별 적재와 동적 parser/DB 의미 대조.
- scripts/realty-income-p6-input.mjs: repo 밖 source cache 재파싱/hash 검증.
- scripts/realty-income-p6-core.mjs: A/B rebuild/실제 SQL rollback/conflict/복수 출처/조회 검증.
- scripts/realty-income-p6-audit.mjs: 외부 cache 필수의 CLI.
- tests/specialized-historical-storage.test.js: 신규 로컬 검증.
- package.json: syntax check/storage-audit 명령.
- docs/realty-income-phase-p6-report.md / docs/realty-income-phase-p6-results.json: 공개 통계/검증 보고.

## 23. Production 변경

production migration / production D1 write / Worker deploy / Pages deploy / UI /
actual production backfill / commit / push: 전부 NO.
로컬 변경은 미커밋이며 HEAD e8ca3b5를 유지한다. 메모리 DB 외 기존 persistent DB write 없음.

## 24. 발견 문제

저장/parser 무결성 blocker 없음, 기존 store 보완 불필요.
조회에서 비교 열과 직접 공시기간을 혼합하면 definition별 동일 기간이 중복될 수 있으므로 source policy를 명시했다.
같은 version이어도 diluted/share의 attribution이 달라지는 경계가 있어 definition 변경과 별도로 표시한다.
SQLite atomicity PASS가 운영 D1 batch 한도/동시쓰기/읽기 후 쓰기 race까지 증명하는 것은 아니다.
향후 rollout에서 99-statement 문서 batch 한도, 안전한 재시도·동시 실행 차단, staged migration 및 API 크기를 별도로 검증해야 한다.

## 25. 다음 단계 판정

A. Disposable backfill / idempotency / query 검증 완료.
다음 Phase에서 production migration/backfill rollout **계획**을 수립할 수 있다.
운영 적용·라우트 연결·실제 backfill은 별도 승인 전 실행하지 않는다.

마지막 YES/NO:

1. 40문서 결과 disposable DB 정상 적재: YES
2. 동일 backfill idempotent: YES
3. provenance 중복 없음: YES
4. conflict overwrite 없음: YES
5. 문서 단위 rollback 가능: YES
6. quarterly/annual/YTD 분리: YES
7. basis/unit 필터 정확: YES
8. definition boundary 식별: YES
9. fresh DB 두 개 동일 결과: YES
10. 다음 단계 production rollout 계획 검토 가능: YES
