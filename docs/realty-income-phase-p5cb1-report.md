# Phase P5C-B1 Definition / Reconciliation Review

## 1. 시작 상태와 범위

시작 Git 상태는 clean, HEAD는 `99592cc92a2fe08d33f84881f9e76643b06ae88f` (`Generalize Realty Income legacy metric parsing`). 기존 441 tests, check, diff check 및 4개 specialized audit가 모두 통과한 뒤 시작했다.

대상은 2017 Q4 / 2021 Q3 / 2023 Q4 세 문서뿐이다. 네트워크 요청, PDF 재다운로드, OCR, 운영 변경, commit/push는 실행하지 않았다. 기존 repo 밖 cache `C:/Users/user/AppData/Local/Temp/stock-phase-p5b-kQmAqb`를 사용했다.

기존 성공 31개의 전체 결과를 구현 전에 외부 `p5ca-regression-baseline.json`으로 고정했다. SHA-256: `c2d444210858ca6eca61ff0bc3c08ab3fd3eb0789e51853eb38a526248cc455a`. 이 baseline은 새 결과로 재생성하지 않았다.

## 2. 2017 Q4: duplicate label

실제 즉시 실패 원인은 FFO 표의 지급 초과/부족 설명 `FFO available to common stockholders (less than) in excess of`다. 기존 numeric 시작 판정에서 `(`를 허용하므로 설명의 `(less than)`까지 총액 후보로 잡았다. AFFO 표에서도 시작 FFO, 최종 AFFO, payout 잔액을 구별해야 한다.

새 review resolver는 section heading, 조정 방향, 직전 adjustment 행, 직후 dilutive noncontrolling 행 및 diluted total 행을 함께 확인한다. 첫 번째/마지막 일치를 선택하지 않는다. AFFO는 실제 FFO 시작점을 별도로 확인한다. 최종 문맥이 두 개이거나 없으면 차단한다.

2017의 FFO 정의는 depreciable real estate impairment를 포함하고, AFFO는 FFO에서 고유 수익/비용을 조정한다. `FFO-DEPRECIABLE-V1` / `AFFO-FFO-DEPRECIABLE-V1`을 재사용한다. NFFO는 미공시이며 만들지 않는다. 결과: PARSED / 32 records.

| 2017 scope | 지표 | common total (USD thousand) | diluted total (USD thousand) | basic/share (USD) | diluted/share (USD) |
| --- | --- | ---: | ---: | ---: | ---: |
| Q4 | FFO | 170,988 | 170,988 | 0.61 | 0.61 |
| Q4 | AFFO | 215,312 | 215,605 | 0.76 | 0.76 |
| FY | FFO | 772,665 | 773,542 | 2.83 | 2.82 |
| FY | AFFO | 838,638 | 839,816 | 3.07 | 3.06 |

## 3. 2021 Q3: 정의 표현과 경제적 의미

Q2는 VEREIT `proposed merger`, Q3는 VEREIT `merger` 관련 비용을 제외한다고 명시한다. Q2/Q3의 실제 NFFO 조정표 행은 모두 `Merger-related costs`, AFFO 시작점은 모두 NFFO다. 이 범위에서 proposed의 제거는 진행 상태 표현 변화이지 비용 제외 범위의 변화가 아니다.

따라서 Q3은 `NFFO-VEREIT-MERGER-V1` / `AFFO-NFFO-VEREIT-V1` 재사용. 기존 정의 metadata/notes는 수정하지 않고 Q3의 실제 문구는 각 source에 보존한다. Q4는 정의 및 조정 행에 integration 비용이 추가되어 기존 Q4 `NFFO-MERGER-INTEGRATION-V1` / `AFFO-NFFO-INTEGRATION-V1`과 구별한다. 연도 차이로 버전을 만들지 않았다.

| 2021 scope | 지표 | common total (USD thousand) | diluted total (USD thousand) | basic/share (USD) | diluted/share (USD) |
| --- | --- | ---: | ---: | ---: | ---: |
| Q3 | FFO | 332,335 | 332,691 | 0.85 | 0.85 |
| Q3 | NFFO | 349,118 | 349,474 | 0.89 | 0.89 |
| Q3 | AFFO | 356,837 | 357,188 | 0.91 | 0.91 |
| 9M YTD | FFO | 914,417 | 915,479 | 2.41 | 2.41 |
| 9M YTD | NFFO | 944,498 | 945,560 | 2.49 | 2.49 |
| 9M YTD | AFFO | 1,002,706 | 1,003,753 | 2.64 | 2.64 |

Q3와 YTD는 독립된 공시행으로 읽었으며 빼기/더하기로 만들지 않았다. 결과: PARSED / 48 records.

## 4. 2023 Q4: Spirit 범위 검토

Q3 NFFO는 VEREIT merger/integration 비용 제외를 명시한다. Q4는 VEREIT **및 Spirit**을 명시한다. 비용 분류 이름은 같지만 명시적 대상 범위가 확장되므로 보수적으로 별도 의미 버전을 만들었다. 2024 Q1의 일반적인 merger/integration 정의만으로 Q4를 소급 자동 승인하지 않았다.

Q4 AFFO는 NFFO에서 시작한다. `Non-cash change in allowance for credit losses` 행이 새로 나타나고 Q1에도 이어진다. debt/compensation/financing/swaps/leasing/capex/straight-line rent/lease amortization/unconsolidated entity 조정 및 footnote를 시각 대조했다. 다만 해당 credit loss나 Other adjustments가 전부 Spirit 때문이라고 추정하지 않는다. 새 AFFO version은 명시적인 NFFO 시작점의 의미 차이를 반영하며, 개별 조정 항목은 원문으로 남긴다.

| 2023 scope | 지표 | common total (USD thousand) | diluted total (USD thousand) | basic/share (USD) | diluted/share (USD) |
| --- | --- | ---: | ---: | ---: | ---: |
| Q4 | FFO | 713,716 | 715,102 | 0.98 | 0.98 |
| Q4 | NFFO | 723,648 | 725,034 | 1.00 | 1.00 |
| Q4 | AFFO | 731,034 | 732,404 | 1.01 | 1.01 |
| FY | FFO | 2,822,138 | 2,827,690 | 4.08 | 4.07 |
| FY | NFFO | 2,836,602 | 2,842,154 | 4.10 | 4.09 |
| FY | AFFO | 2,774,870 | 2,780,410 | 4.01 | 4.00 |

결과: PARSED / 48 records. 주당값과 total은 각각의 공시행을 읽었으며 역산하지 않았다.

## 5. Definition Version

기존 모든 definition row는 불변이다. 신규는 `NFFO-MERGER-INTEGRATION-VEREIT-SPIRIT-V1` / `AFFO-NFFO-VEREIT-SPIRIT-V1` 2개다. 신규 버전의 최초 승인 source URL은 고정하며 후속 문서별 provenance와 분리한다.

40 historical PDF 범위에서는 기존 8 + 신규 2 = 10 definitions. P3 HTML 6개를 함께 메모리 DB에 적재하면 총 16 definitions. 같은 기간/값이어도 definition이 다르면 강제로 dedup하지 않는다. 동일 의미 버전인지 확인되지 않은 문서 간 성장률/비교 가능성을 보증하지 않는다.

## 6. Official Expected와 시각 검토

기존 PDF skill의 지침에 따라 표뿐 아니라 Glossary, 이어지는 정의 문단, footnote를 원문 이미지로 검토했다. 7문서 26페이지를 렌더링/시각 확인했고 OCR은 0회다. 이미지와 PDF 원문은 repo에 추가하지 않았다.

| 문서 | 시각 확인한 물리 PDF 페이지 | 용도 |
| --- | --- | --- |
| 2017 Q4 | 5, 6 | duplicate 문맥, FFO/AFFO 수치 및 정의 footnote |
| 2021 Q2 | 7, 8, 32, 33 | VEREIT proposed merger 정의/조정표 |
| 2021 Q3 | 7, 8, 31, 32 | VEREIT merger 정의/조정표 |
| 2021 Q4 | 7, 8, 32, 33 | integration 범위 변화 |
| 2023 Q3 | 5, 6, 30, 31 | VEREIT 범위 및 AFFO 조정 |
| 2023 Q4 | 5, 6, 30, 31 | Spirit 범위, AFFO/footnote |
| 2024 Q1 | 5, 6, 30, 31 | 후속 일반 정의 및 조정 항목 비교 |

수동 expected는 2017 16개 + 2021 24개 + 2023 24개 = 64개. 64 PASS / 0 FAIL. 이는 현재 연도 대표 공시행의 검증이며 comparison-year 전체의 자동 승인 근거가 아니다. 이번 신규 128 observations는 모두 parsed로 유지한다. 기존 162 validated unique 값은 그대로다.

공개 source URL과 SHA-256 40개는 `realty-income-phase-p5cb1-results.json`에 보존한다. 이 JSON은 공개 metadata/통계뿐이며 원문 cache나 저장용 values 파일이 아니다.

## 7. Layout / Definition / Value 분리

새 검토 경로는 `format_status`, `definition_status`, `value_status`를 분리한다. 예: supported / review / blocked이며 records와 definitions는 빈 배열. 실제 glossary와 비용 행이 일치하고 제외 범위가 승인됐을 때만 canonical record를 만든다.

문구가 미등록 대상/비용으로 바뀌거나 glossary가 누락/충돌하거나 FFO→비용→NFFO 사이에 미검토 제외행이 들어오면 차단한다. 기존 성공 parser 결과는 review adapter에서 그대로 반환한다. Worker 라우트/production 승인 manifest에는 이 read-only 경로를 연결하지 않았다.

## 8. Comparison-year

동일 canonical identity의 comparable 334 / exact 334 / difference 0 / restatement candidate 0. definition이 다른 값은 동일 의미 비교에 넣지 않는다. 합성 테스트에서 comparative가 달라지면 conflict/restatement candidate를 보고하고 overwrite하지 않는 것을 확인했다.

## 9. Full 40-document Status

기존 cache의 원문 SHA-256 40개를 재확인했다. 접근 재시도/재다운로드는 없었다.

VERIFIED_PARSED 9 / PARSED 25 / NEEDS_REVIEW 0 / UNKNOWN_FORMAT 6. WRONG_ISSUER / SOURCE_UNAVAILABLE / PARSER_ERROR 모두 0. 안전 파싱 34/40. 수치를 목표로 status를 변경하지 않았다.

## 10. Quarterly Coverage

| 지표 | common total | diluted/share | diluted total |
| --- | --- | --- | --- |
| FFO | 34/40 | 34/40 | 27/33 공시 기회 |
| AFFO | 34/40 | 34/40 | 27/33 공시 기회 |
| NFFO | 13/19 공시 기회 | 13/19 공시 기회 | 13/19 공시 기회 |

NFFO 전체 inventory 기준은 13/40이며 21개는 실제 미공시다. 미공시 값을 생성하지 않는다.

## 11. Annual Coverage

| 지표 | common total | diluted/share | diluted total |
| --- | --- | --- | --- |
| FFO | 8/10 | 8/10 | 7/9 공시 기회 |
| AFFO | 8/10 | 8/10 | 7/9 공시 기회 |
| NFFO | 3/5 공시 기회 | 3/5 공시 기회 | 3/5 공시 기회 |

NFFO 전체 연말 inventory 기준은 3/10이다. Q4 값을 연간 합산/역산하지 않는다.

## 12. 2024/2025 보호 상태

2024 Q3/Q4는 UNIT_UNKNOWN, 2025 Q1~Q4는 TABLE_AMBIGUITY 그대로다. 6개 모두 UNKNOWN_FORMAT / records 0. 기존 결과와 deep equality로 검증했다. modern unit grammar 및 integrated PDF를 자동 승인하지 않았다.

## 13. Duplicate / Conflict

1080 observations → 746 unique values → 1080 provenance. 동일 값의 중복 관측 334건은 값 row를 늘리지 않고 출처를 보존한다. conflict 0. 원 값 덮어쓰기 0. definition은 canonical identity 일부이며 새로운 의미 버전과 기존 버전을 합치지 않는다.

## 14. 0018 Schema

schema 변경 0 / migration 추가 0 / SCHEMA GAP 없음. Fresh 및 Existing 메모리 SQLite에서 746 historical values / 10 definitions / 1080 provenance round-trip과 idempotency PASS. P3 포함 시 842 values / 16 definitions / 1176 provenance. financial_metrics / company_classification 전체 digest 불변. 실제 D1에는 연결하지 않았다.

## 15. 기존 31개 Regression

구현 전에 고정한 외부 immutable baseline과 full cache audit 결과를 deep equality 비교했다. format/status/raw/canonical/definitions/provenance/availability 모두 동일. baseline 재기준화 없음. 바뀐 결과는 정확히 대상 3개뿐이다.

## 16. 이전 Phase Regression

P3 96/6/96 및 official expected 36 유지. P3+P4 248/14/248 유지. P5A 396 unique/14/420 유지. P5B 안전 17개 고정 결과 유지. P5C-A 기존 성공 31개 전체 결과 유지. 이전 fixture/expected는 수정하지 않았다. 동일 parser의 기본 경로는 기존 441개 oracle을 그대로 통과한다.

## 17. Test 및 Audit

기존 441 + 신규 37 = 478 PASS / 0 FAIL. npm run check / git diff --check PASS.

specialized:audit / specialized:historical-audit / specialized:inventory-audit / specialized:full-historical-audit / specialized:definition-review-audit 모두 PASS. Python helper는 원문 읽기 및 외부 QA 렌더링만 수행한다.

## 18. 수정 파일

package.json; worker/src/reit/realty-income-normalizer.js; worker/src/reit/realty-income-pdf-parser.js; worker/src/reit/realty-income-definition-review.js; scripts/realty-income-p5b-audit.mjs; scripts/realty-income-p5cb1-baseline.mjs; scripts/realty-income-p5cb1-core.mjs; scripts/realty-income-p5cb1-audit.mjs; scripts/realty-income-p5cb1-visual.py; tests/helpers/realty-income-p5cb1-fixtures.js; tests/realty-income-p5cb1.test.js; tests/fixtures/realty-income-p5cb1/official-expected.json; 본 보고서 및 결과 JSON.

기존 normalizer는 불변 definition metadata factory를 export하는 변경이고, parser는 기본 경로를 바꾸지 않는 선택적 context resolver 추가다. UI/scheduler/production config/0018/financial_metrics/company_classification는 수정하지 않았다. 실제 API key/token/email/.dev.vars를 새 파일이나 변경 내용에 넣지 않았다.

## 19. Production 변경

production migration / production DB write / Worker deploy / Pages deploy / UI / actual backfill / commit / push 전부 NO. HEAD는 기존 checkpoint 유지. 변경은 미커밋이다.

## 20. 다음 단계

판정 A: 세 문서 정의 검토 완료. 별도 요청 후 P5C-B2에서 2024/2025 modern unit grammar / integrated PDF / definition 검토 진행 가능. 이번 read-only 성공이 production 저장/배포 승인 또는 미지원 6개 자동 지원을 의미하지 않는다.

최종 확인 1~10: 모두 YES. duplicate 문맥 해결, 2021 정의 판정, Spirit 범위 별도 버전, layout/definition 분리, 기존 schema 표현, comparison/overwrite 정책, modern 6개 미지원, 기존31 불변, 0018 충분, P5C-B2 검토 진행 가능.
