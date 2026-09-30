# Phase P5C-B2 — Modern PDF / Unit / Table Identity

## 1. 시작 상태

checkpoint `d4c353f92a745d2eb09807bec4f13e7abf03b09b`, Git clean. 시작 478 PASS / 0 FAIL, check/diff 및 기존 audit PASS.
구현 전 외부 cache에 성공 34개 전체 결과를 한 번만 고정했다. 이번 변경은 미커밋이며 운영 승인 목록은 그대로다.

## 2. 2024 Q3

- format: `REALTY_INCOME_PDF_STRUCTURAL_LEGACY` 재사용.
- unit: `in thousands, except per share amounts` / qualifier `unaudited`.
- definition: 상각 가능한 부동산 손상 FFO 유지. NFFO는 merger / transaction / other costs 제외로 범위가 넓어졌다.
- official expected: quarterly + 9M YTD, 3 metric × 4 basis × 2 scope = 24/24 PASS.
- 최종 status: PARSED, 48 observations(현재·비교 연도). 자동 validated 승격 없음.

## 3. 2024 Q4

같은 structural format / unit. NFFO는 동일 비용의 **net** 기준을 명시해 별도 보수적 version으로 보존한다.
Spirit transfer-tax adjustment, private-fund organization cost, legacy facility lease termination은 실제 각주에 보존한다.
정의 범위 변경과 해당 기간 금액 변화를 구분하며 금액별 version을 만들지 않는다.
quarterly + FY official expected 24/24 PASS. 최종 PARSED / 48 observations.

## 4. 2025 Integrated Format

`REALTY_INCOME_INTEGRATED_PDF_V1`. 연도별 분기가 아닌 Earnings Release & Supplemental Information 제목,
실제 supplemental footer, FFO/NFFO 및 AFFO 조정 방향, 기간 열, unit, metric별 share layout,
weighted shares, 인접 physical/printed page, 뒤 glossary와 이어지는 AFFO 각주로 식별한다.
공개 metadata 기반 SHA-256 table fingerprint를 출처에 보존한다.
첫/마지막 발견 표를 고르지 않는다. release/역사 요약/appendix는 제외하며 대표 후보가 두 개면 동일 값이어도 차단한다.

## 5. 2025 Unit Grammar

`USD and shares in thousands, except per share amounts`와 `unaudited`를 분리한다.
총액 USD thousand ×1000, per-share USD/share ×1, weighted shares는 raw thousand shares + multiplier 1000을 보존한다.
주식수는 값 계산/역산에 사용하지 않는다. 각 열의 `($)` 통화 근거도 확인한다.
명시적으로 허용한 qualifier는 없음 또는 unaudited뿐이다. 다른 qualifier/통화/백만 단위/두 표 단위 불일치는 차단한다.

## 6. Physical vs Printed Page

| 문서 | FFO 물리/printed | AFFO 물리/printed | 이어지는 각주 물리/printed |
| --- | --- | --- | --- |
| 2025 Q1 | 32 / 15 | 33 / 16 | 34 / 17 |
| 2025 Q2 | 33 / 15 | 34 / 16 | 35 / 17 |
| 2025 Q3 | 33 / 15 | 34 / 16 | 35 / 17 |
| 2025 Q4 | 34 / 16 | 35 / 17 | 36 / 18 |

기존 `page_number`는 physical page로 유지한다. `physical_page` / `printed_page`는 0018 provenance JSON에 추가한다.

## 7. 2025 Q1

3M quarterly만 생성한다. YTD 3M 복제 없음. FFO/NFFO joint basic+ diluted, AFFO separate.
12 official expected PASS. 현재/비교 연도 합계 24 observations, PARSED.

## 8. 2025 Q2

standalone Q2와 6M YTD 분리. 세 metric 모두 직접 joint share 공시행.
24 official expected PASS, 48 observations, PARSED. 총액/주당값은 공시행을 직접 읽으며 차감 계산 없음.

## 9. 2025 Q3

standalone Q3 / 9M YTD 분리. FFO joint, NFFO/AFFO separate.
private-fund placement fee는 net 정의 안의 기간별 조정항목이며 새 definition 사유가 아니다.
24 official expected PASS, 48 observations, PARSED.

## 10. 2025 Q4

Q4 standalone / FY2025 annual 분리. 세 metric 모두 separate shares.
24 official expected PASS, 48 observations, PARSED.

## 11. FY2025 SEC HTML vs IR PDF

FFO/NFFO/AFFO × common total/diluted total/basic share/diluted share = **12/12 exact**, difference 0, conflict 0.
P3 SEC fixture/expected/definition/records는 수정하지 않았다. 2026 Q2 값을 근거로 2025 형식을 승인하지 않았다.

## 12. Definition Continuity

- 2023 Q4: B1의 명시적 VEREIT/Spirit merger/integration 정의 유지.
- 2024 Q1/Q2: 기존 merger/integration 정의와 전체 결과 유지.
- 2024 Q3: merger/transaction/other costs의 포괄적 제외 문구와 실제 조정행을 확인, 새 gross 의미 version.
- 2024 Q4: net 명시, 새 net 의미 version.
- 2025 Q1~Q4: net 정의 유지. financing, swap amortization, stock compensation, credit loss,
  straight-line rent, leasing/capex, deferred tax, unconsolidated/other adjustments는 실제 표·각주에 보존.
- FFO의 depreciable real estate impairment 범위는 기존 version 유지.

정의/제외 원칙 변화만 version 사유다. layout/연도/adjustment amount 변화로 version을 만들지 않는다.

## 13. 신규 Definition Version

신규 4개(각각 NFFO/AFFO 연계)이며 기존 record 변경 없음:

- `NFFO-MERGER-TRANSACTION-OTHER-V1`
- `AFFO-NFFO-TRANSACTION-OTHER-V1`
- `NFFO-MERGER-TRANSACTION-OTHER-NET-V1`
- `AFFO-NFFO-TRANSACTION-OTHER-NET-V1`

좁은 merger/integration 범위와 넓은 transaction/other 범위를 자동 동등시하지 않으며 gross/net도 보수적으로 분리한다.
공식 source URL은 정의의 고정 근거로, 문서별 실제 문구는 각각 provenance로 보존한다.

## 14. Official Expected

132 수동 expected / 132 PASS / 0 FAIL. 원문 PDF 표/각주/glossary를 렌더링해서 대조했다.
expected는 fixture/audit/test에만 있다. production parser는 숫자를 읽으며 expected 숫자로 분기하지 않는다.
신규 264 observations는 모두 parsed이며 수동 대조를 이유로 다른 comparison/기간 값을 자동 validated 승격하지 않는다.

## 15. Source Provenance

PDF hash, 발췌 hash, document, source URL, actual physical/printed page, section, raw table heading,
table fingerprint, unit measurement/qualifier, share disclosure, glossary paragraph, 전체 대표 조정표/각주를 보존한다.
PDF 원문 및 QA 이미지는 기존 repo 밖 cache에만 있다. OCR/네트워크 재다운로드 0회.

SEC는 문서별 version, IR은 의미별 version이므로 기본 record identity는 서로 다르다.
숫자 일치만으로 병합하지 않는다. FY2025에 한해 source hash 및 정의/조정표 대조를 명시한 **테스트 전용 동등성 view**에서
12 canonical values / 24 provenance를 메모리 SQLite로 확인했다. 원본 SEC/IR version과 validation 상태는 출처에 보존한다.
실제 parser/store의 자동 version 병합이나 historical DB backfill은 구현/실행하지 않았다.

## 16. 기존 34개 Regression

외부 cache의 구현 전 고정 snapshot과 동일 입력의 전체 결과 deep equality PASS.
format/status/records/raw/canonical/definitions/provenance/scope/basis/availability 불변.
offline fixture도 별도 고정 digest 34개로 보호한다. cache와 최소 fixture는 일부 소개/공시일 evidence 입력이 달라
서로의 결과를 직접 혼용하지 않는다. 비교 입력을 같게 유지했으며 baseline 재생성 없음.

## 17. Full 40 Status

VERIFIED_PARSED 9 / PARSED 31 / NEEDS_REVIEW 0 / UNKNOWN_FORMAT 0.
WRONG_ISSUER / SOURCE_UNAVAILABLE / PARSER_ERROR 모두 0. 안전 파싱 40/40.
새 6문서는 PARSED이며 VERIFIED_PARSED로 상태를 조작하지 않았다.

## 18. Quarterly Coverage

FFO/AFFO common total 및 basic/diluted per-share 각각 40/40.
diluted total 33/40: 과거 7개 문서의 미공시 값을 역산하지 않음.
NFFO 19/19 공시 기회 모두 확보. 이전 21개 미공시에는 숫자 생성 없음.

## 19. Annual Coverage

FFO/AFFO common total 및 basic/diluted per-share 각각 10/10.
diluted total 9/10. NFFO 5/5 공시 기회 확보, 이전 5개 미공시 유지.

## 20. Duplicate / Provenance

1344 observations → 950 unique values → 1344 provenance. historical 의미 정의는 14개(기존 10 + 신규 4).
같은 definition/period/basis/value는 값 하나 + 복수 provenance.
definition이 다른 값은 동일 숫자여도 자동 병합하지 않는다.

## 21. Conflict / Restatement

동일 definition identity에서 비교 가능한 394건 모두 exact. difference 0 / conflict 0 / restatement candidate 0.
다른 정의로 비교 불가능한 조합은 이 숫자에 포함하지 않는다. conflict 합성 테스트에서 덮어쓰기 차단 PASS.

## 22. 0018 Schema

기존 schema와 source_metadata_json으로 충분. 변경/새 migration 없음.
FY2025 12-value/24-source 단위 테스트에서 physical/printed/unit/review metadata round-trip 및 idempotency PASS.
기존 financial_metrics/company_classification digest 불변. 전체 historical disposable backfill은 다음 Phase로 보류했다.

## 23. Test

기존 478 + 신규 65 = **543 PASS / 0 FAIL**.
`npm run check`, `git diff --check`, specialized/historical/inventory/definition-review/full-historical/modern audit PASS.
full-historical/modern audit는 기존 외부 cache의 40 source hashes까지 확인한다.

## 24. 수정 파일

- `worker/src/reit/realty-income-modern-units.js`, `realty-income-modern-definitions.js`, `realty-income-modern-pdf.js`: 신규 독립 adapter.
- `worker/src/reit/realty-income-pdf-parser.js`: 선택적 unit resolver 한 줄. 기존 호출 기본 동작 불변.
- `scripts/realty-income-p5cb2-{baseline,core,cross-source,audit}.mjs`: 고정 회귀/읽기 전용 감사/명시적 source 대조.
- `scripts/realty-income-p5cb2-{excerpts,visual}.py`: 기존 PDF 최소 발췌/시각 QA. 원문/이미지 repo 저장 없음.
- `scripts/realty-income-p5b-audit.mjs`: 기존 경로를 oracle로 유지하고 새 adapter/34개 보호 추가.
- `scripts/realty-income-p5b-core.mjs`: 새 format도 감사 format 집계에 누락되지 않게 동적 집계.
- `tests/helpers/realty-income-p5cb2-fixtures.js`, `tests/realty-income-p5cb2.test.js`.
- `tests/fixtures/realty-income-p5cb2/{documents,official-expected,regression-digests,cross-source-review}.json`.
- `package.json`: syntax check/modern audit 명령.
- 본 보고서 / `docs/realty-income-phase-p5cb2-results.json`: 공개 source metadata/통계만.

UI / scheduler / production config / migration / 기존 expected 수정 없음.
민감정보/전체 PDF/download cache/QA PNG/OCR/임시파일 repo 포함 없음.

## 25. Production 변경

production migration / production DB write / Worker deploy / Pages deploy / UI / actual backfill / commit / push: 전부 NO.
HEAD 유지. 로컬 변경은 다음 별도 checkpoint 검토 대상이다.

## 26. 다음 단계 판정

**A**: 40문서 parsing coverage/integrity 충분. 다음 Phase에서 disposable historical DB backfill,
idempotency, API contract, historical query를 검증할 수 있다. 운영 승인과는 별개다.
정의가 다른 시기의 자동 연속 비교/SEC-IR 자동 병합은 별도의 의미 검토가 필요하다.

최종 YES/NO:

1. 2024 unaudited unit 안전 처리: YES
2. 2024 Q3/Q4 definition 판정: YES
3. 2025 integrated fingerprint 식별: YES
4. 대표 table identity 안전: YES
5. 총액/주식수 천 단위와 per-share 분리: YES
6. Q1/Q2/Q3/Q4 scope 안전: YES
7. FY2025 SEC/IR 공식값 대조: YES
8. 기존 34개 regression 없음: YES
9. 0018 schema 충분: YES
10. 다음 Phase disposable historical backfill 검증 시작 가능: YES
