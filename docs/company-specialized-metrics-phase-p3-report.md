# Phase P3 로컬 구현·검증 보고서

## 1. 시작 상태

- HEAD: `46e0a419c0793423bc4ea93f0bd21bb6619976a3`, `Add company analysis profile classification`.
- 시작 Git 상태 clean, 기존 테스트 199 PASS / 0 FAIL, `npm run check` PASS, `git diff --check` PASS.
- 구현 전 승인 범위: 로컬 저장구조와 최근 공식 HTML 두 문서만. 운영 상태는 재검증/수정하지 않았다.

## 2. 저장구조 설계

범용 long-format 구조를 세 테이블로 분리했다.

- `company_metric_definitions`: 회사별/문서별 정의.
- `company_metric_values`: 기간·기준별 단일 공시값.
- `company_metric_sources`: 하나의 값에 여러 출처를 연결.

기존 `financial_metrics`에 REIT 컬럼을 추가하지 않는다.
동일 `metric_code` + `value_basis`를 선택했다. 장점은 total/per-share에 정의가 중복되지 않고
BANK/EXCHANGE 지표도 같은 저장소를 사용할 수 있다는 것이다. 단점은 조회/차트에서
`value_basis`, `share_basis`, `attribution_basis` 필터를 반드시 명시해야 한다는 것이다.
다른 basis의 합산/교환은 허용하지 않는다.

현재 Node/Worker의 ES module·빌드 없는 JavaScript 관례를 유지했다.
전체 React/TypeScript 전환이나 새 빌드 도구를 도입하지 않고 런타임 검증과 테스트를 추가했다.

## 3. 생성 Migration

`worker/migrations/0018_company_specialized_metrics.sql`.

새 테이블 3개와 조회 인덱스만 추가한다. 기존 migration 수정, DROP/ALTER/DELETE/UPDATE,
기존 금액 UPDATE, 공식값 seed는 없다. 로컬 메모리 SQLite에서만 적용했다.

## 4. Metric Definition 구조

`metric_code`, `definition_owner`, `definition_version`을 복합 PK로 사용한다.
`display_name`, `profile`, `metric_family`, `default_unit`, `definition_source`,
`definition_notes`를 보존한다.

최초 정의: `FFO`, `NORMALIZED_FFO`, `AFFO`.
회사 식별: `CIK0000726728`.
버전: `EX99.1-2025-Q4`, `EX99.1-2026-Q2`.

이 버전은 문서별 정의 근거를 식별한다. 두 시점의 정의가 반드시 달라졌다는 의미는 아니다.
이전 2016년 정의와 같다고 가정하지 않는다. AFFO는 회사 고유 조정표·Glossary 근거를 명시했다.

## 5. Metric Value 구조

`ticker`, 정의 연결, 기간, FY/FQ, 세 basis, 원값/단위/multiplier,
canonical 값/단위, validation 상태/근거를 보존한다.
`record_key`와 UNIQUE 제약이 기간/basis/정의 버전별 독립성을 보장한다.

같은 키의 상충값/상충 정의를 덮어쓰지 않는다.
반복 실행은 idempotent이며 `validated`를 `parsed`로 강등하지 않는다.
FK 및 batch 실패는 SQLite 트랜잭션으로 전체 rollback된다.

## 6. Basis/Unit 설계

| 값 | value_basis | share_basis | attribution_basis |
|---|---|---|---|
| common total | total | not_applicable | common_stockholders |
| diluted total | total | diluted | common_and_dilutive_noncontrolling_interests |
| basic/share | per_share | basic | common_stockholders |
| diluted/share | per_share | diluted | common_and_dilutive_noncontrolling_interests |

총액은 `raw_unit=USD thousand`, multiplier 1000, canonical `USD`.
주당값은 `USD/share`, multiplier 1.
FFO/AFFO를 GAAP에서 자체 계산하지 않는다. 공시 숫자를 읽고 단위만 변환한다.

## 7. Period Scope

`annual`, `quarterly`, `ytd`, `ttm`을 지원한다.

- FY2025: 2025-01-01~2025-12-31, annual, FY2025/FY.
- Q2 FY2026 standalone: 2026-04-01~2026-06-30, quarterly, Q2 FY2026/Q2.
- Q2 FY2026 YTD: 2026-01-01~2026-06-30, ytd, Q2 FY2026 YTD/Q2.

공식 EX-99.1의 Q2/Q4 문서 식별, 실제 Three/Six months/Years 표 머리글,
12/31 연말 공시 근거를 함께 검증한다. 6월이라는 이유만으로 Q2를 추정하지 않는다.
지원하지 않는 기간/문서는 needs_review다. TTM 저장은 합성 테스트로 검증했고 실제 TTM을 계산하지 않았다.

## 8. Provenance

source_type/url/accession/exhibit/document_name/filed_at/published_at,
table_title/section/page_number/source_hash/retrieved_at 및 추가 원문 근거 JSON을 보존한다.

공식 원천:

- [FY2025 SEC EX-99.1](https://www.sec.gov/Archives/edgar/data/726728/000072672826000009/o-991q42025.htm), 2026-02-24.
- [2026 Q2 SEC EX-99.1](https://www.sec.gov/Archives/edgar/data/726728/000072672826000044/o-991q22026.htm), 2026-08-05.

필요한 두 조정표씩 약 21KB를 발췌해 저장했다. 원문 전체 hash와 발췌 hash를 구분하고
발췌 hash를 재검증한다. HTML에 PDF page_number를 만들어 넣지 않는다.
실제 SEC/IR 이중 원문 대조는 아직 하지 않았다. 복수 출처 저장 가능성은 명시적 synthetic IR 테스트로만 확인했다.

## 9. Parser 구조

- `worker/src/reit/realty-income-mappings.js`: 승인 문서 metadata·label·정의 근거.
- `worker/src/reit/realty-income-parser.js`: 소스/hash, 표 구역, colspan, 기간 열, basis, 숫자 판정.
- `worker/src/specialized-metrics.js`: record 및 expected 검증.
- `worker/src/specialized-metric-store.js`: 정의/값/출처 쓰기·읽기.

기존 Worker API·ingestion·scheduler에는 연결하지 않았다.
최근 두 HTML 형식만 지원하는 제한된 adapter이며 범용 HTML/PDF 플랫폼이라고 주장하지 않는다.
향후 legacy/PDF/다른 REIT는 별도 adapter로 같은 record 계약을 사용할 수 있다.

## 10. FY2025 파싱 결과

총액 Raw/Expected 단위는 USD thousand, Canonical은 USD다. 주당값은 모두 USD/share.

| Metric | Basis | Raw | Canonical | Expected (Raw) | PASS/FAIL |
|---|---|---:|---:|---:|---|
| FFO | common total | 3860323 | 3860323000 | 3860323 | PASS |
| FFO | diluted total | 3869719 | 3869719000 | 3869719 | PASS |
| FFO | basic/share | 4.26 | 4.26 | 4.26 | PASS |
| FFO | diluted/share | 4.25 | 4.25 | 4.25 | PASS |
| NORMALIZED_FFO | common total | 3884537 | 3884537000 | 3884537 | PASS |
| NORMALIZED_FFO | diluted total | 3893933 | 3893933000 | 3893933 | PASS |
| NORMALIZED_FFO | basic/share | 4.28 | 4.28 | 4.28 | PASS |
| NORMALIZED_FFO | diluted/share | 4.27 | 4.27 | 4.27 | PASS |
| AFFO | common total | 3885898 | 3885898000 | 3885898 | PASS |
| AFFO | diluted total | 3895221 | 3895221000 | 3895221 | PASS |
| AFFO | basic/share | 4.28 | 4.28 | 4.28 | PASS |
| AFFO | diluted/share | 4.28 | 4.28 | 4.28 | PASS |

## 11. 2026 Q2 standalone 결과

| Metric | Basis | Raw | Canonical | Expected (Raw) | PASS/FAIL |
|---|---|---:|---:|---:|---|
| FFO | common total | 996600 | 996600000 | 996600 | PASS |
| FFO | diluted total | 998944 | 998944000 | 998944 | PASS |
| FFO | basic/share | 1.07 | 1.07 | 1.07 | PASS |
| FFO | diluted/share | 1.07 | 1.07 | 1.07 | PASS |
| NORMALIZED_FFO | common total | 998658 | 998658000 | 998658 | PASS |
| NORMALIZED_FFO | diluted total | 1001002 | 1001002000 | 1001002 | PASS |
| NORMALIZED_FFO | basic/share | 1.07 | 1.07 | 1.07 | PASS |
| NORMALIZED_FFO | diluted/share | 1.07 | 1.07 | 1.07 | PASS |
| AFFO | common total | 1022120 | 1022120000 | 1022120 | PASS |
| AFFO | diluted total | 1024458 | 1024458000 | 1024458 | PASS |
| AFFO | basic/share | 1.1 | 1.1 | 1.1 | PASS |
| AFFO | diluted/share | 1.09 | 1.09 | 1.09 | PASS |

## 12. 2026 Q2 YTD 결과

| Metric | Basis | Raw | Canonical | Expected (Raw) | PASS/FAIL |
|---|---|---:|---:|---:|---|
| FFO | common total | 1990201 | 1990201000 | 1990201 | PASS |
| FFO | diluted total | 1994578 | 1994578000 | 1994578 | PASS |
| FFO | basic/share | 2.14 | 2.14 | 2.14 | PASS |
| FFO | diluted/share | 2.13 | 2.13 | 2.13 | PASS |
| NORMALIZED_FFO | common total | 2003046 | 2003046000 | 2003046 | PASS |
| NORMALIZED_FFO | diluted total | 2007423 | 2007423000 | 2007423 | PASS |
| NORMALIZED_FFO | basic/share | 2.15 | 2.15 | 2.15 | PASS |
| NORMALIZED_FFO | diluted/share | 2.14 | 2.14 | 2.14 | PASS |
| AFFO | common total | 2079673 | 2079673000 | 2079673 | PASS |
| AFFO | diluted total | 2084445 | 2084445000 | 2084445 | PASS |
| AFFO | basic/share | 2.23 | 2.23 | 2.23 | PASS |
| AFFO | diluted/share | 2.22 | 2.22 | 2.22 | PASS |

## 13. Standalone/YTD 분리 검증

같은 period_end라도 scope·period_start·label·record_key가 달라 별도 저장된다.
예: AFFO common total Q2 1,022,120과 YTD 2,079,673,
diluted/share Q2 1.09와 YTD 2.22가 서로 바뀌지 않는다.
누적값을 차감하여 분기값을 계산하지 않고 공식 3개월 열 자체를 읽는다.

## 14. DB round-trip

두 문서 총 96 records / 6 definitions / 96 SEC provenance를 메모리 SQLite에 저장·복원해 전체 deepEqual PASS.
세 검증기간 36건만 official expected와 대조되어 validated.
비교연도와 Q4 60건은 파싱만 확인했으므로 parsed 유지.
복수 출처, 중복 재실행, 승격 상태 보존, 상충값 거절, FK 실패 rollback PASS.

재현: `npm run specialized:audit`. 키/환경변수/네트워크/운영 DB 옵션이 없는 offline 도구다.
새 테이블 데이터는 메모리 DB 종료 시 사라지며 로컬/운영 영구 DB에 적재하지 않았다.

## 15. Parser failure 처리

metric 누락/중복, 불명확한 colspan/rowspan/연도 열, 기간 범위 불명확,
단위 미확보, basic/diluted 누락·중복, 비숫자,
hash 불일치, 미지원 accession/URL/회계기간 근거를 테스트했다.
실패하면 `status=needs_review`, 오류 code/message, records 빈 배열을 반환한다.
일부 성공값, 추정값, 자동 0/null은 저장하지 않는다.

FFO 시작 행의 공식 반복은 조정 구역 순서·횟수·모든 열 값의 동일성을 검사해 제한적으로 허용한다.
Weighted average shares의 Basic/Diluted를 per-share 값으로 오인하지 않는다.

## 16. 기존 financial/classification regression

기존 199개 테스트 유지.
NULL·0·음수·양수를 포함한 기존 재무 전 수치열과 classification override를 넣은 메모리 DB에서
migration 및 저장 전후 전체 행 SHA-256 digest 동일: 변화 0건.
기존 UI/financial-chart.js/GAAP 계산/분류/ingestion/scheduler 파일 변경 없음.

## 17. Migration 검증

- Fresh: 0001~0018 PASS.
- Existing: 0017 상태에 기존 데이터를 넣은 후 0018만 적용 PASS.
- 기존 migration 변경 없음, additive-only YES.
- production migration 0017/0018 적용 NO.

## 18. Test

- 기존: 199 PASS.
- 신규: 68 PASS.
- 총: 267 PASS / 0 FAIL.
- `npm run check`: 신규 모듈까지 포함, PASS.
- `git diff --check`: PASS.
- `npm run specialized:audit`: PASS.
- 새 파일의 trailing whitespace 및 실제 로컬 secret/이메일 검사: 문제 없음.
- UI 변경이 금지된 단계이므로 새 UI 브라우저 검증은 수행하지 않았다.

## 19. 변경 파일

- `package.json`: check 대상 추가와 offline audit script.
- `worker/migrations/0018_company_specialized_metrics.sql`.
- `worker/src/specialized-metrics.js`.
- `worker/src/specialized-metric-store.js`.
- `worker/src/reit/realty-income-mappings.js`.
- `worker/src/reit/realty-income-parser.js`.
- `scripts/specialized-metrics-audit.mjs`.
- `tests/specialized-metrics.test.js`.
- `tests/helpers/specialized-metrics-db.js`.
- `tests/helpers/realty-income-fixtures.js`.
- `tests/fixtures/realty-income/README.md`.
- `tests/fixtures/realty-income/fy2025.html`.
- `tests/fixtures/realty-income/fy2025.source.json`.
- `tests/fixtures/realty-income/q2-2026.html`.
- `tests/fixtures/realty-income/q2-2026.source.json`.
- `tests/fixtures/realty-income/official-expected.json`.
- `docs/company-specialized-metrics-phase-p3-report.md`.

## 20. Production 변경

production migration / DB write / Worker deploy / Pages deploy / UI 변경 / commit / push: 모두 NO.
BusinessQuant/FMP 호출 NO. 10년 backfill 및 PDF 대량 파싱 NO.
Git HEAD 유지. Phase P3 파일들은 의도적으로 미커밋 상태다.

## 21. 발견 문제·제약

- 최근 공시에서 FFO common 행과 Basic/Diluted label이 반복된다. 구역/순서/열 검증으로 오인 방지.
- 2016 등 과거의 미공시 Normalized FFO를 보완·추정하지 않는다.
- 문서별 정의 버전을 semantic 정의 변경 여부로 오해하지 않아야 한다.
- 두 최근 HTML 성공은 과거 40분기 성공이나 IR 이중 검증을 의미하지 않는다.
- 실제 D1 배치/호출 제한, 운영 수집 동시성, API 연결은 이번 범위 밖이며 운영 연결 전에 별도 검증해야 한다.

## 22. 다음 단계

저장구조와 검증 계약은 준비됐지만, **현재 파서로 10년 전체 historical dry-run을 실행할 준비는 아직 안 됐다**.
현재 adapter는 승인한 두 최근 문서 외에는 fail-closed이므로 기존 코드를 그대로 40분기 돌릴 수 없다.
다음 Phase에서 소량 legacy HTML부터 별도 adapter/expected를 추가하고,
PDF는 승인된 별도 단계에서 검증해야 한다. 10년 backfill/운영 적재는 아직 승인·구현하지 않았다.

| 최종 확인 | YES/NO |
|---|---|
| 1. 범용 specialized metric 저장구조 구현 | YES |
| 2. BANK/EXCHANGE 확장 가능 | YES |
| 3. FY2025 공식값 일치 | YES |
| 4. Q2 standalone 공식값 일치 | YES |
| 5. Q2 YTD/standalone 구분 | YES |
| 6. total/basic/diluted 기준 구분 | YES |
| 7. 원 단위/canonical 단위 보존 | YES |
| 8. provenance 보존 | YES |
| 9. 기존 재무/분류 변화 없음 | YES |
| 10. 현재 파서로 O 10년 historical dry-run 가능 | NO — 다음 Phase에서 legacy adapter와 소량 검증부터 필요 |
