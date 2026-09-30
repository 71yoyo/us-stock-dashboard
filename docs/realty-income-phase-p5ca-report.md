# Realty Income Phase P5C-A 완료 보고서

## 1. 시작 상태

checkpoint: `05c68bd7164334f4e8e78af8b28e05013cf532cd` - `Audit full Realty Income historical coverage`.
시작 Git clean. 기존 380 PASS / 0 FAIL, check / diff / P3 / P4 / P5A / full P5B audit 모두 PASS 후 구현했다.
기존 repo 밖 P5B cache의 원문만 재사용했다. 새 다운로드/API 호출/OCR은 0회다.

## 2. 처리 대상 15개

S = `REALTY_INCOME_PDF_STRUCTURAL_LEGACY`.
P = `parseRealtyIncomePdfText` (read-only audit; production approval unchanged).
목록은 audit 범위일 뿐 parser 승인 조건이 아니다. 15개 구조를 판별했으나 안전 값 파싱은 14개다.

| 문서 | Before | After | Format | Adapter | Definition status | FFO / NFFO / AFFO share layout |
|---|---|---|---|---|---|---|
| 2016-q1 | UNKNOWN_FORMAT | PARSED | S | P | 기존 semantic version 일치 | joint_basic_diluted / absent / separate |
| 2017-q3 | UNKNOWN_FORMAT | PARSED | S | P | 기존 semantic version 일치 | joint_basic_diluted / absent / separate |
| 2018-q1 | UNKNOWN_FORMAT | PARSED | S | P | 기존 semantic version 일치 | joint_basic_diluted / absent / joint_basic_diluted |
| 2018-q2 | UNKNOWN_FORMAT | PARSED | S | P | 기존 semantic version 일치 | separate / absent / joint_basic_diluted |
| 2019-q1 | UNKNOWN_FORMAT | PARSED | S | P | 기존 semantic version 일치 | joint_basic_diluted / absent / joint_basic_diluted |
| 2019-q4 | NEEDS_REVIEW | PARSED | S | P | 기존 semantic version 일치 | joint_basic_diluted_subrow / absent / separate |
| 2020-q1 | UNKNOWN_FORMAT | PARSED | S | P | 기존 semantic version 일치 | joint_basic_diluted / absent / joint_basic_diluted |
| 2020-q4 | NEEDS_REVIEW | PARSED | S | P | 기존 semantic version 일치 | joint_basic_diluted_subrow / absent / separate |
| 2021-q1 | NEEDS_REVIEW | PARSED | S | P | 기존 semantic version 일치 | joint_basic_diluted_subrow / absent / joint_basic_diluted_subrow |
| 2021-q4 | NEEDS_REVIEW | PARSED | S | P | 기존 semantic version 일치 | joint_basic_diluted / separate / separate |
| 2022-q4 | UNKNOWN_FORMAT | PARSED | S | P | 기존 semantic version 일치 | joint_basic_diluted / separate / separate |
| 2023-q1 | UNKNOWN_FORMAT | PARSED | S | P | 기존 semantic version 일치 | separate / joint_basic_diluted / separate |
| 2023-q2 | UNKNOWN_FORMAT | PARSED | S | P | 기존 semantic version 일치 | separate / joint_basic_diluted / separate |
| 2023-q4 | UNKNOWN_FORMAT | NEEDS_REVIEW | S | P | DEFINITION_REVIEW | separate / separate / separate |
| 2024-q1 | UNKNOWN_FORMAT | PARSED | S | P | 기존 semantic version 일치 | separate / joint_basic_diluted / separate |

각 행의 URL, 원문 SHA256, 단위, 구조 feature, 오류, 건수는 `realty-income-phase-p5ca-results.json`에 기록했다.
기존 inventory 승인 목록과 기존 P5B 결과 snapshot은 수정하지 않았다.

## 3. 의도적 제외 8개

| 문서 | 유지 상태 | 차단 이유 |
|---|---|---|
| 2017-q4 | NEEDS_REVIEW | DUPLICATE_LABEL - 반복 reconciliation 문맥 |
| 2021-q3 | NEEDS_REVIEW | DEFINITION_UNKNOWN - NFFO 정의 변화 |
| 2024-q3 / 2024-q4 | UNKNOWN_FORMAT | UNIT_UNKNOWN - unaudited 단위 grammar 미지원 |
| 2025-q1 / q2 / q3 / q4 | UNKNOWN_FORMAT | TABLE_AMBIGUITY - integrated 문서 identity/표 구조 |

8개 전부 numeric record 0, 자동 PARSED/SUPPORTED 승격 없음. 테스트와 full audit guard로 고정했다.

## 4. 추가 Structural Strategy

metric별 FFO / NORMALIZED_FFO / AFFO share layout을 독립적으로 판별한다.
`separate`, `joint_basic_diluted`, `joint_basic_diluted_subrow`, NFFO `absent`를 지원한다.
diluted total은 present/absent, 기간은 single quarter / quarter+6M / quarter+9M / quarter+FY를 판별한다.
이번 문서 집합의 FFO/AFFO diluted-total 공시 존재는 일치하며, 한쪽만 공시된 비대칭 구조는 차단한다.
기존 legacy fingerprint를 우선하여 기존 17개의 format/출처를 바꾸지 않았다.
parser 복제와 대규모 architecture rewrite는 하지 않았다.

## 5. Joint Basic/Diluted 처리

원문에 명시된 공동행만 공시값을 basic/share와 diluted/share 두 basis에 각각 기록한다.
canonical key는 다르고 공시값 및 source row는 같다.
`source_basis=joint_basic_diluted`, 원 label/page/hash, `structural_features`를 보존한다.
숫자 열 개수 불일치, 중복 label, conflicting Basic/Diluted 행, 모호한 label은 차단한다.
역산/주식수 곱셈 등 산술 추정은 없다.

## 6. Metric별 Share Layout

FFO joint / AFFO separate, FFO+AFFO joint, FFO separate / AFFO joint,
FFO joint / NFFO separate / AFFO separate,
FFO separate / NFFO joint / AFFO separate, all-three separate를 같은 추출기로 처리한다.
2023 Q4 all-three separate는 구조 검증 성공이나 정의 검토로 canonical record는 만들지 않는다.

## 7. Unit Grammar

지원:
- (dollars in thousands, except per share amounts)
- (in thousands, except per share and share count data)
- (in thousands, except per share amounts)

쉼표 앞 공백 같은 의미 동일 표현만 허용한다.
총 monetary 값 ×1000 USD, per-share ×1 USD/share.
weighted shares는 source label 기준 shares / shares thousand만 보존한다.
2023 Q2부터 원 weighted share-count 단위가 thousand임을 확인했다.
weighted share-count 값 변경에도 metric 값은 불변이다.
unaudited suffix, 현대 USD-and-shares grammar, millions는 이번 Phase에서 지원하지 않는다.

## 8. Q1 처리

하나의 3M column group이면 quarterly만 생성한다. 같은 기간의 ytd numeric row를 추가하지 않는다.
기존 period_scope/start/end와 single_quarter 구조 feature로 충분하여 추가 schema/중복 flag를 만들지 않았다.
모든 Q1 후보에서 canonical key 중복 0.

## 9. Q4/FY 처리

공시된 Q4 standalone 3M와 FY를 각각 quarterly / annual로 저장 가능한 record로 만든다.
2019/2020/2021/2022 Q4는 안전 파싱. 2023 Q4는 두 scope 구조 검증만 통과하고 값은 미승인.
FY-9M 차감 및 계산 분기 생성 없음.

## 10. Definition 안전장치

표 구조 판별과 definition 승인은 별개다.
FFO 손상 범위, AFFO 조정 시작점, NFFO 비용 제외 문구를 실제 text로 확인한다.
새 structural NFFO 경로는 이미 승인한 merger/integration 비용 범위의 완결된 문구만 허용한다.
2023 Q4에는 VEREIT뿐 아니라 Spirit이 명시되므로 `DEFINITION_REVIEW`로 남긴다.
2021 Q4의 VEREIT merger/integration 문구, 2022 Q4·2023 Q1/Q2의 VEREIT 문구,
2024 Q1의 일반 merger/integration 문구는 기존 version과 같은 승인 범위로 재사용하고 실제 원문을 provenance에 보존한다.
연도/ticker로 version을 선택하지 않는다. 이후 조정 내역의 경제적 비교 가능성을 자동 보증하지 않는다.

| 문서 | 재사용 definition version |
|---|---|
| 2016-q1 | FFO-REAL-ESTATE-V1 / AFFO-FFO-REAL-ESTATE-V1 |
| 2017-q3 | FFO-DEPRECIABLE-V1 / AFFO-FFO-DEPRECIABLE-V1 |
| 2018-q1 | FFO-DEPRECIABLE-V1 / AFFO-FFO-DEPRECIABLE-V1 |
| 2018-q2 | FFO-DEPRECIABLE-V1 / AFFO-FFO-DEPRECIABLE-V1 |
| 2019-q1 | FFO-DEPRECIABLE-V1 / AFFO-FFO-DEPRECIABLE-V1 |
| 2019-q4 | FFO-DEPRECIABLE-V1 / AFFO-FFO-DEPRECIABLE-V1 |
| 2020-q1 | FFO-DEPRECIABLE-V1 / AFFO-FFO-DEPRECIABLE-V1 |
| 2020-q4 | FFO-DEPRECIABLE-V1 / AFFO-FFO-DEPRECIABLE-V1 |
| 2021-q1 | FFO-DEPRECIABLE-V1 / AFFO-FFO-DEPRECIABLE-V1 |
| 2021-q4 | FFO-DEPRECIABLE-V1 / AFFO-NFFO-INTEGRATION-V1 / NFFO-MERGER-INTEGRATION-V1 |
| 2022-q4 | FFO-DEPRECIABLE-V1 / AFFO-NFFO-INTEGRATION-V1 / NFFO-MERGER-INTEGRATION-V1 |
| 2023-q1 | FFO-DEPRECIABLE-V1 / AFFO-NFFO-INTEGRATION-V1 / NFFO-MERGER-INTEGRATION-V1 |
| 2023-q2 | FFO-DEPRECIABLE-V1 / AFFO-NFFO-INTEGRATION-V1 / NFFO-MERGER-INTEGRATION-V1 |
| 2023-q4 | 미승인 - 생성 없음 |
| 2024-q1 | FFO-DEPRECIABLE-V1 / AFFO-NFFO-INTEGRATION-V1 / NFFO-MERGER-INTEGRATION-V1 |

실제 definition text를 재사용해도 다른 문서의 definition source/notes 계약을 변경하지 않는다.

## 11. 새 Official Expected 검증

PDF skill을 사용하여 실제 표의 label/기간/단위/각주를 PNG로 시각 확인했다.
대표 8개 PDF, FFO/AFFO 16페이지의 수동 expected 68개가 전부 일치했다.
대표: 2016 Q1, 2017 Q3, 2018 Q1, 2018 Q2, 2019 Q4, 2021 Q4, 2023 Q2, 2023 Q4.
FFO/AFFO common total과 diluted/share, NFFO 존재 시 동일 2항목,
Q2/Q3/Q4에는 standalone과 YTD/FY 쌍을 검증했다.
56개는 승인된 definition의 canonical 결과 대조, 12개(2023 Q4)는 structure-only 원 관측값 대조다.
expected는 test fixture에만 있으며 parser 코드에는 없다.
수동 테스트 일치만으로 전체 parsed record를 자동 validated로 승격하지 않았다.
2021 Q4(33쪽), 2023 Q4(31쪽), 2024 Q1(31쪽)의 정의도 추가 시각 확인했다.
그 밖의 후보는 cache의 실제 행/기간/단위/definition text로 검토했다.

## 12. 기존 17개 Regression

확장 전 전체 audit 결과를 repo 밖 `p5b-regression-baseline.json`에 고정했다.
full audit에서 기존 17개 전체 document 결과를 `assert.deepEqual`로 대조했다:
format, records, canonical/raw 값, definitions, sources/provenance, status, availability, 구조 전부 동일.
offline 테스트에서도 고정 SHA256 manifest를 대조하여 record의 모든 출처 필드와 definition 변경을 차단한다.
baseline은 새로운 결과로 재생성하거나 숫자를 수정하지 않았다.
기존 17개 deep regression 0건.

## 13. Full 40-document Status

| 상태 | 문서 수 |
|---|---:|
| VERIFIED_PARSED | 9 |
| PARSED | 22 |
| NEEDS_REVIEW | 3 |
| UNKNOWN_FORMAT | 6 |
| WRONG_ISSUER | 0 |
| SOURCE_UNAVAILABLE | 0 |
| PARSER_ERROR | 0 |

총 40/40 방문, 원문 cache hash 40/40 일치.
안전 파싱 31/40, 구조 해결 뒤 정의만 보류한 2023 Q4 1개.
원문 PDF/TXT는 변경하지 않았으며 외부 cache의 audit 결과 JSON만 갱신했다.

## 14. Quarterly Coverage

현재 primary quarter만 분자에 포함한다. comparison year/YTD는 분자에 더하지 않는다.

| 지표 | Common total | Diluted/share | Diluted total(추가 조사) |
|---|---:|---:|---:|
| FFO | 31/40 | 31/40 | 24/33 공시 |
| AFFO | 31/40 | 31/40 | 24/33 공시 |
| NORMALIZED_FFO | 11/19 공시 | 11/19 공시 | 11/19 공시 |

NFFO 전체 40문서 중 공시 19, 미공시 21, 공시 여부 unknown 0.
NFFO를 전체 inventory 기준으로 보면 11/40이며 미공시를 실패와 섞지 않았다.

## 15. Annual Coverage

| 지표 | Common total | Diluted/share | Diluted total(추가 조사) |
|---|---:|---:|---:|
| FFO | 6/10 | 6/10 | 5/9 공시 |
| AFFO | 6/10 | 6/10 | 5/9 공시 |
| NORMALIZED_FFO | 2/5 공시 | 2/5 공시 | 2/5 공시 |

NFFO 전체 annual 기회 10 중 공시 5, 미공시 5.
coverage 목표로 status/정의를 강제하지 않았다.

## 16. Duplicate / Provenance

952 observations → 658 unique values → 952 provenance.
294 comparison-year observation이 모두 exact match(294/294).
같은 canonical key/같은 값은 하나의 값 + 복수 provenance,
joint basic/diluted는 서로 다른 basis key + 공동 source row 정책을 유지한다.
기존 validated unique key 162는 그대로다. 새로운 14문서는 전부 parsed 상태다.

## 17. Conflict

실제 full-cache conflict 0건, restated/comparative difference 0건.
합성 값 충돌 테스트에서는 양쪽 값/출처를 보존하고 자동 overwrite하지 않는다.

## 18. 0018 Schema

기존 0018으로 충분: YES.
migration 변경/추가 0.
Fresh와 Existing 메모리 SQLite에서 658 값/952 source round-trip + idempotency PASS.
joint provenance/structural feature metadata 보존, 검토 중 결과 저장 거부 PASS.
운영 DB를 사용하지 않았다.

## 19. P3/P4/P5A/P5B Regression

- P3: 96 records / 6 definitions / 96 provenance / official expected 36 유지.
- P3+P4: 248 records / 14 definitions / 248 provenance 유지.
- P5A: 396 unique / 14 definitions / 420 provenance 유지.
- P5B: 기존 17개 전체 deep equality PASS.
- 기존 financial_metrics / company_classification digest 변화 0.
- 로컬 보호 fixture digest: `72697ec4807b949de38e22f64991ac338a726741e895c3d5396189ac2735e0dc`.
- P3/P4/P5A expected, 기존 inventory/results snapshot 변경 없음.
- wrong issuer/VEREIT rejection 및 NFFO 미공시 생성 금지 유지.

## 20. Test

기존 380 + 신규 61 = 441 PASS / 0 FAIL.
npm run check PASS, git diff --check PASS.
specialized:audit / historical-audit / inventory-audit / full-historical-audit 모두 PASS.
full audit 명령:
`npm run specialized:full-historical-audit -- --read-only-cache <기존 repo 밖 P5B cache>`.

## 21. 수정 파일

기존 파일:
- package.json: 새 모듈/도구 syntax check 추가.
- worker/src/reit/realty-income-document-formats.js: 기존 format 우선 + structural fallback.
- worker/src/reit/realty-income-pdf-parser.js: 명시적 공동행/복수형 Year header/구조-정의 분리.
- worker/src/reit/realty-income-normalizer.js: structural definition guard + 공동행 metadata.
- scripts/realty-income-p5b-core.mjs: 단위 공백 grammar, 공통 발췌/출처 builder, 구조/정의 상태 보존.
- scripts/realty-income-p5b-audit.mjs: 기존 17개 전체 결과와 제외 8개 보호 guard.

추가 파일:
- worker/src/reit/realty-income-structural-strategy.js
- scripts/realty-income-p5ca-baseline.mjs (확장 전 baseline 생성 도구, 재기준화 금지)
- scripts/realty-income-p5ca-regression.mjs
- tests/helpers/realty-income-p5ca-fixtures.js
- tests/realty-income-p5ca.test.js
- tests/fixtures/realty-income-p5ca/*.json: 후보15/기존 parsed8/제외8의 최소 발췌31 + expected + baseline manifest.
- docs/realty-income-phase-p5ca-results.json
- docs/realty-income-phase-p5ca-report.md

repo에 전체 PDF/PNG/OCR/cache/Temp file 없음. fixture는 최소 표 발췌와 공개 metadata/expected만 포함한다.
Secret/API key/token/실제 이메일/환경변수 값 없음.
현재 파일은 미커밋이며 staged 변경도 없다.

## 22. Production 변경

production migration: NO
production DB write: NO
Worker deploy: NO
Pages deploy: NO
UI change: NO
actual backfill: NO
commit: NO
push: NO

Worker 라우트, scheduler, production config, 기존 financial_metrics 계산, company_classification는 변경하지 않았다.
Production 승인 manifest는 기존 9개 PDF만 유지한다.

## 23. 다음 단계 판정

A. 구조적 adapter 확장 성공.
15개 구조는 판별했고 14개만 안전 값 파싱으로 허용했다.
남은 2023 Q4 1개 + 의도적 제외 8개 = 9개는 P5C-B definition/modern-format 검토로 넘길 수 있다.
운영 수집/backfill 승인은 별도이며 이번 결과만으로 자동 저장하지 않는다.

### 마지막 YES/NO

1. 15개 후보 중 안전한 문서만 지원됐는가? YES
2. joint/separate share 구조가 일반화됐는가? YES
3. Basic and Diluted 공동행을 안전하게 처리하는가? YES
4. Q1 중복 numeric row가 생성되지 않는가? YES
5. Q4/FY scope가 안전하게 분리되는가? YES
6. 정의가 불확실한 문서는 차단되는가? YES
7. 제외 8개가 P5C-B 전까지 차단 상태인가? YES
8. 기존 17개 parser regression이 없는가? YES
9. 0018 schema가 여전히 충분한가? YES
10. 다음 P5C-B definition/modern-format 검토로 넘어가도 되는가? YES
