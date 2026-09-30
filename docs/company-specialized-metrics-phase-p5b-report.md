# Phase P5B — Realty Income 전체 Historical Read-only Dry-run

결론: 조사 기준 충족, 실제 backfill 준비 판정은 **B**. 40개 접근·식별·최종 상태를 확정했지만, 파싱은 17개이고 23개는 안전하게 차단했다. C에 해당하는 정의/단위 후보 조사도 다음 단계에서 필요하다. 이 보고서는 운영 저장 승인이나 40/40 지원 선언이 아니다.

## 1. 시작 상태

Checkpoint: `0bcf1d0dfe1cbdd9250ab6553eb0e9486ea9b943` — `Add Realty Income historical inventory coverage`.
Git clean 확인. 기존 352 PASS / 0 FAIL, check/diff 및 P3/P4/P5A audit 모두 PASS 후 조사 시작.

## 2. 전체 Dry-run 범위

총 inventory 40 / 방문 40 / source 접근 성공 40 / 실패 0. P5A inventory만 사용했다. 각 공식 IR PDF 한 번씩 총 40회 다운로드, 재시도 0, SEC 요청 0. 원문은 repo 밖 임시 cache에만 보관. 데이터 제공자 API 호출 없음. PDF text extraction과 40개 문서·80개 조정표의 render/시각 확인 수행; OCR 0회.

## 3. 최종 Status

| Status | 문서 수 |
| --- | --- |
| VERIFIED_PARSED | 9 |
| PARSED | 8 |
| NEEDS_REVIEW | 6 |
| UNKNOWN_FORMAT | 17 |
| WRONG_ISSUER | 0 |
| SOURCE_UNAVAILABLE | 0 |
| PARSER_ERROR | 0 |

VERIFIED_PARSED는 기존 검증 9개에만 적용했다. 신규 8개는 parsed이며 모든 숫자의 수동 expected 검증을 했다는 의미가 아니다. NEEDS_REVIEW는 basis/label/definition 모호함, UNKNOWN_FORMAT은 기존 adapter로 안전하게 처리 불가. 실제 wrong issuer/access/parser error는 0.

## 4. 기존 9개 Regression

같은 원문 hash 확인 후 이전 immutable 발췌를 기존 parser로 다시 실행했다. format, records, definitions, provenance, validation 상태를 전체 결과 deep equality로 확인: 모두 동일. fixture/expected 숫자 수정 없음. 운영 approval manifest는 여전히 기존 9개이고 신규 8개 승인으로 확장하지 않았다.

## 5. 새롭게 처리 가능해진 문서 수

8개: 2016 Q2/Q3, 2017 Q2, 2018 Q4, 2019 Q3, 2020 Q2, 2022 Q1/Q2. 기존 fingerprint와 일치하는 구조만 사용했다. 의미가 동일한 제목 대소문자/acronym/각주 표기만 audit 발췌에서 정규화했다. 행/열/값/연도 기반 예외 없음.

## 6. 새 Format 발견

다음 후보는 새 adapter 구현 없이 기록했다. 제목만 같은 문서를 같은 format으로 강제하지 않았다. 상세 차이/heading/share row/기간/단위/출처는 부록 A에 23개 모두 기록했다.

- joint FFO + separate AFFO, diluted total 없음: 2016 Q1 / 2017 Q3.
- joint FFO/AFFO + diluted total, Normalized FFO 없음: 2018 Q1 / 2019 Q1 / 2020 Q1.
- separate FFO + joint AFFO: 2018 Q2.
- Basic and Diluted 단일 하위 행: 2019 Q4 / 2020 Q4 / 2021 Q1.
- joint FFO + separate Normalized FFO/AFFO: 2021 Q4 / 2022 Q4 / 2024 Q3.
- separate FFO + joint Normalized FFO + separate AFFO: 2023 Q1/Q2 / 2024 Q1.
- all-separate Normalized 구조: 2023 Q4 / 2024 Q4.
- 2025 통합 PDF의 supplemental/appendix, 새 제목/단위/정의 및 조정항목: Q1–Q4.
- 2017 Q4 label 중복 및 2021 Q3 정의 문구 차이는 별도 review 원인이다.

## 7. Format별 결과

| Format | documents | parsed | needs_review | unknown | failed |
| --- | --- | --- | --- | --- | --- |
| A | 1 | 1 | 0 | 0 | 0 |
| B | 8 | 4 | 4 | 0 | 0 |
| C | 3 | 3 | 0 | 0 | 0 |
| D | 1 | 1 | 0 | 0 | 0 |
| A-J | 4 | 4 | 0 | 0 | 0 |
| B-M | 2 | 2 | 0 | 0 | 0 |
| C-M | 3 | 2 | 1 | 0 | 0 |
| UNKNOWN | 18 | 0 | 1 | 17 | 0 |

별칭: A=separate/no diluted total, A-J=joint/no diluted total, B=separate/diluted total, B-M=joint FFO/separate AFFO, C=normalized joint, C-M=normalized joint FFO/separate AFFO, D=normalized mixed. 정확한 canonical id는 결과 JSON의 detected_format 참조. SEC_HTML_V1은 이번 40개 PDF 범위에서 0개이며 PDF를 HTML 형식으로 간주하지 않았다. UNKNOWN 그룹 18개 중 1개는 basis ambiguity로 NEEDS_REVIEW이다.

## 8. 연도별 결과

| 연도 | Q1 | Q2 | Q3 | Q4 | 성공 |
| --- | --- | --- | --- | --- | --- |
| 2016 | UNKNOWN_FORMAT | PARSED | PARSED | VERIFIED_PARSED | 3/4 |
| 2017 | VERIFIED_PARSED | PARSED | UNKNOWN_FORMAT | NEEDS_REVIEW | 2/4 |
| 2018 | UNKNOWN_FORMAT | UNKNOWN_FORMAT | VERIFIED_PARSED | PARSED | 2/4 |
| 2019 | UNKNOWN_FORMAT | VERIFIED_PARSED | PARSED | NEEDS_REVIEW | 2/4 |
| 2020 | UNKNOWN_FORMAT | PARSED | VERIFIED_PARSED | NEEDS_REVIEW | 2/4 |
| 2021 | NEEDS_REVIEW | VERIFIED_PARSED | NEEDS_REVIEW | NEEDS_REVIEW | 1/4 |
| 2022 | PARSED | PARSED | VERIFIED_PARSED | UNKNOWN_FORMAT | 3/4 |
| 2023 | UNKNOWN_FORMAT | UNKNOWN_FORMAT | VERIFIED_PARSED | UNKNOWN_FORMAT | 1/4 |
| 2024 | UNKNOWN_FORMAT | VERIFIED_PARSED | UNKNOWN_FORMAT | UNKNOWN_FORMAT | 1/4 |
| 2025 | UNKNOWN_FORMAT | UNKNOWN_FORMAT | UNKNOWN_FORMAT | UNKNOWN_FORMAT | 0/4 |

2025 PDF 0/4는 자료 미공시가 아니라 현재 PDF adapter 미지원이다. P3의 같은 기간 SEC HTML 검증 결과를 이 PDF coverage에 대신 합산하지 않았다.

## 9. Quarterly Metric Coverage

| metric | common total | diluted total | basic/share | diluted/share | 분모 |
| --- | --- | --- | --- | --- | --- |
| FFO | 17/40 | 12/33 | 17/40 | 17/40 | 해당 basis 실제 공시 기간 |
| AFFO | 17/40 | 12/33 | 17/40 | 17/40 | 해당 basis 실제 공시 기간 |
| NORMALIZED_FFO | 6/19 | 6/19 | 6/19 | 6/19 | 해당 basis 실제 공시 기간 |

분모: 2016–2025의 서로 다른 primary standalone quarter 40개. 각 PDF에 FFO/AFFO 조정표와 3개월·주당값 공시를 확인했다. 비교연도/YTD observation은 분자에 넣지 않았다. Normalized FFO는 조사 범위 내 2021 Q2부터 명시 공시되어 19기간이 기대 분모; 21기간은 not_reported. 전체 기간 기준 availability는 6/40이지만 실제 공시 coverage는 6/19이다. 희석 총액은 2016 Q1–2017 Q3의 7기간에 미공시: 실제 공시 33기간을 분모로 12/33이다 (전체 availability 12/40). 희석 총액이 없는 성공 문서 5개에서 이를 계산해 만들지 않았다.

## 10. Annual Metric Coverage

| metric | common total | diluted total | basic/share | diluted/share | 분모 |
| --- | --- | --- | --- | --- | --- |
| FFO | 2/10 | 1/9 | 2/10 | 2/10 | 해당 basis 실제 공시 FY |
| AFFO | 2/10 | 1/9 | 2/10 | 2/10 | 해당 basis 실제 공시 FY |
| NORMALIZED_FFO | 0/5 | 0/5 | 0/5 | 0/5 | 해당 basis 실제 공시 FY |

분모는 Q4/FY 문서에 명시된 10개 FY annual periods. FFO/AFFO 성공은 FY2016·FY2018만 2/10. FFO/AFFO 희석 총액은 FY2016 미공시라 1/9이다 (전체 availability 1/10). Normalized FFO FY2021–2025는 공시 5개, 파싱 0/5 (전체 FY availability 0/10). 0은 확보된 기간 수이지 numeric 0 값 생성이 아니다.

## 11. Scope

Q1은 3M quarterly 한 의미만 생성하고 동일 YTD row 중복 생성 없음. Q2 standalone 3M와 6M YTD, Q3 standalone 3M와 9M YTD를 분리. Q4 3M와 FY annual을 분리. 해당 열이 모호하면 차단한다. FY−9M 파생값/추정 quarter 없음. 원문 identity/분기 footer 확인 뒤 native parser의 날짜 열 규칙으로 검증했다.

## 12. Unit Audit

40개 raw labels와 정규화 가능 여부는 부록 B. 지원 단위만 monetary USD thousand ×1000 / USD per share ×1로 정규화했다. dollars in thousands 또는 and share count data 표기는 가중주식수 shares, 이후 in thousands except per share amounts는 shares thousand로 구분한다. 2024 Q3/Q4의 unaudited suffix와 2025 USD and shares 명시 단위는 현재 native unit grammar가 미지원: 원문 기록만 하고 강제 정규화하지 않았다. 표시된 thousands를 millions로 추측하지 않았다. 미지원 단위와 새 layout이 함께 있는 문서는 format 단계에서 먼저 차단될 수 있다.

## 13. Duplicate

Observations 564 / unique metric keys 464 / unique values 464 / provenance 564. 동일 의미·동일 값 100개는 값 하나에 복수 출처로 통합. 현재 충돌 0이어서 unique keys와 unique values가 같다. canonical key는 company/metric/scope/period/basis/share basis/definition을 포함한다. 이 합계는 성공 17개 PDF의 comparison/YTD/annual 포함 observation 집계이고 quarterly coverage 분자가 아니다. 본 audit에서는 JS 메모리 dedup만 사용했고 DB backfill 없음.

## 14. Conflict

실제 파싱 subset: 0건, 해당 period/metric 없음. 미파싱 23개까지 무충돌이라고 주장하지 않는다. 합성 conflict 테스트는 2개 값/출처를 보존하고 delta를 보고하며 정답 선택/overwrite를 하지 않는다.

## 15. Comparison-year / Restatement

비교 가능한 값 100 / exact match 100 / difference 0 / restated candidate 0. primary source와 later comparative source의 동일 canonical key만 비교했다. definition이 다른 값을 억지 비교하지 않는다. 비교 가능한 subset 밖 restatement 유무는 미확정이다.

## 16. Definition Version

이번 성공 PDF subset에서 기존 definition version 8개 재사용: `FFO-REAL-ESTATE-V1`, `AFFO-FFO-REAL-ESTATE-V1`, `FFO-DEPRECIABLE-V1`, `AFFO-FFO-DEPRECIABLE-V1`, `AFFO-NFFO-VEREIT-V1`, `NFFO-VEREIT-MERGER-V1`, `AFFO-NFFO-INTEGRATION-V1`, `NFFO-MERGER-INTEGRATION-V1`. 기존 P3/P4/P5A 전체 baseline 14 definitions와 모집단이 다르다. 레이아웃만 달라 새 definition을 만들지 않았다. 2021 Q3의 proposed merger → merger 및 후속 조정항목 변화는 정의 재사용/새 버전 후보로 남겼고 저장 정책을 자동 확정하지 않았다. 신규 값 자동 validated 승격 없음: 이번 dedup unique keys 중 기존 validated 162 / parsed-only 302. 기존 모든 source의 검증 상태는 원래대로 보존.

## 17. Source Hash / Changed Source

40개 SHA-256 계산 완료. 이전 validated fixture를 가진 9개 hash 모두 동일, SOURCE_CHANGED 0. 신규 31개는 최초 다운로드 hash가 기준이며 이전 byte 일치라고 주장하지 않는다. 부록 C에 hash/공시일/physical page 기록. published_at은 신규 값에서 PDF가 명시한 관련 earnings exhibit의 SEC 공개일 근거이며 별도 IR 게시일은 미확인; accession/CIK의 문서 내 명시가 없으면 임의 생성하지 않는다.

## 18. Wrong Issuer

실제 WRONG_ISSUER 0 / Realty Income NYSE: O identity 확인 40. CIK 0000726728은 inventory의 식별 metadata이며 PDF마다 CIK/accession이 인쇄됐다고 주장하지 않는다. 합병 설명의 VEREIT/Spirit는 허용하지만 identity의 주체가 다른 회사면 중단하는 합성 rejection regression PASS.

## 19. 40개 Adapter Support Matrix

전체 표는 아래 및 `docs/realty-income-phase-p5b-results.json`에 보존한다. 자료실: [Realty Income 공식 quarterly/annual results](https://www.realtyincome.com/investors/quarterly-and-annual-results).

| Year | Quarter | Source | Format | Adapter | Issuer | Source status | Parser status | FFO | Norm FFO | AFFO | Per-share | Final status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2016 | Q1 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2016/q1/Realty-Income-Q1-16-Supplemental-Information.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | not_reported | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2016 | Q2 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2016/q2/Realty-Income-Q2-16-Supplemental-Information.pdf) | A-J | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | not_reported | parsed | basic + diluted | PARSED |
| 2016 | Q3 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2016/q3/Realty-Income-Q32016-Supplemental-Information.pdf) | A-J | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | not_reported | parsed | basic + diluted | PARSED |
| 2016 | Q4 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2016/q4/Realty-Income-Q4-16-Supplemental-Information.pdf) | A | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | not_reported | parsed | basic + diluted | VERIFIED_PARSED |
| 2017 | Q1 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2017/q1/Realty-Income-Q1-17-Supplemental-Information.pdf) | A-J | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | not_reported | parsed | basic + diluted | VERIFIED_PARSED |
| 2017 | Q2 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2017/q2/Realty-Income-Q2-17-Supplemental-Information.pdf) | A-J | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | not_reported | parsed | basic + diluted | PARSED |
| 2017 | Q3 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2017/q3/Realty-Income-Q3-2017-Supplemental-Information.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | not_reported | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2017 | Q4 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2017/q4/Realty-Income-Q4-2017-Supplemental-Information.pdf) | B | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | needs_review | 공시·미파싱 | not_reported | 공시·미파싱 | 공시·미파싱 | NEEDS_REVIEW |
| 2018 | Q1 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2018/q1/Realty-Income-Q1-2018-Supplemental-Information.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | not_reported | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2018 | Q2 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2018/q2/Realty-Income-Q2-2018-Supplemental-Information.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | not_reported | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2018 | Q3 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2018/q3/Realty-Income-Q3-2018-Supplemental-Information.pdf) | B-M | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | not_reported | parsed | basic + diluted | VERIFIED_PARSED |
| 2018 | Q4 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2018/q4/Realty-Income-Q4-2018-Supplemental-Information.pdf) | B | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | not_reported | parsed | basic + diluted | PARSED |
| 2019 | Q1 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2019/q1/Realty-Income-Q1-2019-Supplemental-Information_0.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | not_reported | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2019 | Q2 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2019/q2/Realty-Income-Q2-2019-Supplemental-Information.pdf) | B | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | not_reported | parsed | basic + diluted | VERIFIED_PARSED |
| 2019 | Q3 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2019/q3/Realty-Income-Q3-2019-Supplemental-Information.pdf) | B | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | not_reported | parsed | basic + diluted | PARSED |
| 2019 | Q4 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2019/q4/Realty-Income-Q4-2019-Supplemental-Information.pdf) | B | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | needs_review | 공시·미파싱 | not_reported | 공시·미파싱 | 공시·미파싱 | NEEDS_REVIEW |
| 2020 | Q1 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartly-tab-2020/Realty-Income-Q1-2020-Supplemental-Information-.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | not_reported | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2020 | Q2 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartly-tab-2020/Realty-Income-Q2-2020-Supplemental-Information.pdf) | B-M | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | not_reported | parsed | basic + diluted | PARSED |
| 2020 | Q3 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartly-tab-2020/Realty-Income-Q3-2020-Supplemental-Information.pdf) | B | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | not_reported | parsed | basic + diluted | VERIFIED_PARSED |
| 2020 | Q4 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/quartly-and-annual/2020/Realty-Income-Q4-2020-Supplemental-Information-2.22.21.pdf) | B | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | needs_review | 공시·미파싱 | not_reported | 공시·미파싱 | 공시·미파싱 | NEEDS_REVIEW |
| 2021 | Q1 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/quartly-and-annual/2021/Realty-Income-Q1-2021-Supplemental-Information-new.pdf) | B | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | needs_review | 공시·미파싱 | not_reported | 공시·미파싱 | 공시·미파싱 | NEEDS_REVIEW |
| 2021 | Q2 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/quartly-and-annual/2021/Realty-Income-Q2-2021-Supplemental-Information-8.2.2021-new.pdf) | C | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | parsed | parsed | basic + diluted | VERIFIED_PARSED |
| 2021 | Q3 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/quartly-and-annual/2021/Realty-Income-Q3-2021-Supplemental-Information-11.1.21-new.pdf) | C-M | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | needs_review | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | NEEDS_REVIEW |
| 2021 | Q4 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2021/Realty-Income-Q4-2021-Supplemental-Information.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | NEEDS_REVIEW |
| 2022 | Q1 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/quartly-and-annual/2022/Realty-Income-Q1-2022-Supplemental-Information-5.4.22-links.pdf) | C | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | parsed | parsed | basic + diluted | PARSED |
| 2022 | Q2 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/Realty%20Income%20Q2%202022%20Supplemental%20Information%208.3.22.pdf) | C-M | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | parsed | parsed | basic + diluted | PARSED |
| 2022 | Q3 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/Realty-Income-Q3-2022-Supplemental-Information-Final.pdf) | C | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | parsed | parsed | basic + diluted | VERIFIED_PARSED |
| 2022 | Q4 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/realty-income-q4-2022-supplemental-information-2-21-23.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2023 | Q1 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2023-05/realty-income-q1-2023-supplemental-information.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2023 | Q2 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2023-07/Realty%20Income%20Q2%202023%20Supplemental%20Information%20Final%20Compressed.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2023 | Q3 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2023-11/realty-income-q3-2023-supplemental-information.pdf) | C-M | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | parsed | parsed | basic + diluted | VERIFIED_PARSED |
| 2023 | Q4 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/quartly-and-annual/realty-income-q4-2023-supplemental-information.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2024 | Q1 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2024-05/Realty_Income_Q1_2024_Supplemental_Information_FINAL.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2024 | Q2 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2024-08/realty-income-q2-2024-supplemental-information.pdf) | D | 기존 PDF parser (audit만) | Realty Income / O | HTTP 200 / AVAILABLE | parsed | parsed | parsed | parsed | basic + diluted | VERIFIED_PARSED |
| 2024 | Q3 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2024-11/realty-income-q3-2024-supplemental-information.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2024 | Q4 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2025-02/realty-income-q4-2024-supplemental-information.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2025 | Q1 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2025-05/Realty_Income_Earnings_Release_and_Supplemental_Information_Q1_2025.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2025 | Q2 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2025-08/realty-income-earnings-release-and-supplemental-information-q2-2025.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2025 | Q3 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2025-11/realty-income-earnings-release-and-supplemental-information-q3-2025.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |
| 2025 | Q4 | [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2026-02/q4-2025-supplemental-report.pdf) | UNKNOWN | 미선택 | Realty Income / O | HTTP 200 / AVAILABLE | NOT_RUN | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | 공시·미파싱 | UNKNOWN_FORMAT |

## 20. 0018 Schema

충분: YES. 기존 metric/definition/provenance/validation/scope/basis 구조로 조사 결과 표현 가능. migration 0018 변경 없음. 미지원 adapter·정의 검토 필요가 곧 schema 변경 필요를 뜻하지 않는다.

## 21. P3/P4/P5A Regression

P3: 96 records / 6 definitions / 96 provenance / 공식 expected 36 유지.
P3+P4: 248 records / 14 definitions / 248 provenance 유지.
P5A: 396 unique records / 14 definitions / 420 provenance 유지.
P5A 단독 duplicate 정책: 172 observations → 148 unique values → 172 provenance 유지.
기존 financial_metrics/company_classification digest 불변. UI/financial calculation/scheduler/config/0018 및 기존 expected 변경 없음. 종전 baseline과 이번 40 PDF 집계는 대상/source가 달라 직접 교체 비교하지 않는다.

## 22. Test

최종 npm test: 기존 352개 유지 + 신규 28개 = **380 PASS / 0 FAIL**. npm run check / git diff --check / specialized:audit / specialized:historical-audit / specialized:inventory-audit / specialized:full-historical-audit 모두 PASS. Python helper AST syntax 검사 PASS. all visited/status/source/issuer/hash/format/coverage/scope/unit/conflict/validation/승인 manifest 및 baseline regression을 검증한다.

## 23. 수정 파일

- `package.json`: audit 명령 및 신규 JS syntax check.
- `worker/src/reit/realty-income-document-formats.js`: 기존 pdfFingerprint export와 의도 주석만 추가; parser 동작/승인 목록 변경 없음.
- `scripts/realty-income-p5b-fetch.mjs`: 명시적 read-only-download 인자, 공식 inventory 1회 다운로드, repo 밖 cache.
- `scripts/realty-income-p5b-extract.py`: cache PDF text/선택 조정표/identity/공시일 추출. 환경에 pdftotext가 없어 pypdf layout extraction 사용.
- `scripts/realty-income-p5b-core.mjs`: pure audit/classification/coverage/dedup/comparison.
- `scripts/realty-income-p5b-audit.mjs`: cache hash 확인·기존 9개 대조·메모리 결과 기록.
- `scripts/realty-income-p5b-visual.py`: repo 밖 임시 render/QA contact sheets.
- `tests/realty-income-p5b.test.js`: 신규 offline tests.
- 이 보고서 및 `docs/realty-income-phase-p5b-results.json`: 공개 source metadata/statistics만 보관; 전체 PDF/HTML/다운로드 cache/전체 numeric rows 없음.

재실행: `npm run specialized:full-historical-audit -- --read-only-cache <repo 밖 기존 cache>`. 이 명령은 외부 API/DB에 연결하지 않고 해당 cache에 결과 JSON만 기록한다. 원문 다운로드 명령은 별도 opt-in이므로 재시험 때 다시 다운로드하지 않는다.

## 24. Production 변경

Production migration / DB write / Worker deploy / Pages deploy / UI change / actual backfill / commit / push: **전부 NO**. 로컬 persistent production-like backfill도 NO. API key/token/실제 이메일/환경변수 값은 신규 파일에 포함하지 않았다. 변경 대상 Secret/fixture 검사 PASS. QA PNG는 repo 밖에서만 생성했고 분석 후 정리했으며 원문 cache는 재사용을 위해 보존한다.

## 25. 실제 Backfill 준비 여부

**B. 일부 format adapter 추가 필요. 운영 backfill 금지.** 조사 자체의 안전 성공 조건은 충족했지만 quarter FFO/AFFO 17/40, annual 2/10으로 전체 historical backfill 준비 완료는 아니다. 2021 Q3 및 최신 조정항목/단위는 C에 해당하는 추가 정의 검토도 필요하다.

## 26. 다음 단계 제안

1. 별도 Phase에서 23개 차단 문서의 구조를 묶어 최소 발췌/수동 expected 검증 계획부터 수립.
2. 주당값 joint/separate 방향·하위 Basic and Diluted 행·중복 조정 label을 새로운 명시적 adapter로 처리.
3. 최신 단위/share count, 2021 merger 문구, 2024/2025 조정 의미를 정의별 대조. 의미 동일일 때만 재사용.
4. P3/P4/P5A unchanged 회귀 후 동일 cache 전체 재실행. 충분한 coverage/integrity를 확보한 다음 별도 승인 아래 disposable DB backfill 검증; 아직 실행하지 않음.

### 마지막 YES/NO

| 질문 | 답 |
| --- | --- |
| 40개 inventory 전부 확인 | YES |
| 각 문서 최종 상태 결정 | YES |
| 기존 9개 regression 없음 | YES |
| wrong issuer 안전 차단 | YES |
| quarterly/ytd/annual 안전 | YES (지원 문서 검증, 미지원 차단) |
| unit/basis 안전 | YES (지원 단위만 정규화) |
| duplicate/conflict 안전 | YES |
| metric별 실제 coverage 확정 | YES |
| 0018 schema 충분 | YES |
| 다음 단계에서 실제 historical backfill 검증 시작 가능 | NO (adapter/definition 검증 먼저) |

# 부록 A — 차단 문서별 실제 구조와 원인

### [NEW FORMAT / REVIEW] 2016 Q1

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2016/q1/Realty-Income-Q1-16-Supplemental-Information.pdf)
- 기존 구조와 차이 / 필요한 adapter: FFO joint / AFFO separate이지만 diluted total 없음. B-M의 diluted total 필수 구조와 다르며 AFFO 단위의 쉼표 앞 공백도 있음.
- Table headings: FUNDS FROM OPERATIONS (FFO) / ADJUSTED FUNDS FROM OPERATIONS (AFFO)
- Share rows: FFO: FFO per common share, basic and diluted $ 0.68 $ 0.68; Basic 250,173,815 225,346,407; Diluted 250,381,001 225,508,832 / AFFO: AFFO per common share:; Basic $ 0.70 $ 0.68; Diluted $ 0.70 $ 0.67; Basic 250,173,815 225,346,407; Diluted 250,381,001 225,508,832
- Period columns: Three months ended; 2016 2015 / Three months ended; 2016 2015
- Units: (dollars in thousands, except per share amounts) / (dollars in thousands , except per share amounts)
- Normalized FFO: not_reported
- Physical pages: 5, 6
- 현재 상태: UNKNOWN_FORMAT; FORMAT_UNSUPPORTED

### [NEW FORMAT / REVIEW] 2017 Q3

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2017/q3/Realty-Income-Q3-2017-Supplemental-Information.pdf)
- 기존 구조와 차이 / 필요한 adapter: FFO joint / AFFO separate, diluted total 없음. A-J의 all-joint 및 B-M의 diluted total 구조와 다름.
- Table headings: Funds From Operations (FFO) / Adjusted Funds From Operations (AFFO)
- Share rows: FFO: FFO per common share, basic and diluted $ 0.77 $ 0.73 2.22 2.11; Basic 275,511,870 258,085,633 270,584,365 253,953,149; Diluted 276,050,671 258,356,892 271,126,114 254,223,301 / AFFO: AFFO per common share; Basic $ 0.78 $ 0.72 $ 2.30 $ 2.14; Diluted $ 0.77 $ 0.72 $ 2.30 $ 2.14; Basic 275,511,870 258,085,633 270,584,365 253,953,149; Diluted 276,138,853 258,356,892 271,214,296 254,458,747
- Period columns: Three months ended Nine months ended; 2017 2016 2017 2016 / Three months ended Nine months ended; 2017 2016 2017 2016
- Units: (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts)
- Normalized FFO: not_reported
- Physical pages: 5, 6
- 현재 상태: UNKNOWN_FORMAT; FORMAT_UNSUPPORTED

### [NEW FORMAT / REVIEW] 2017 Q4

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2017/q4/Realty-Income-Q4-2017-Supplemental-Information.pdf)
- 기존 구조와 차이 / 필요한 adapter: B 후보이나 AFFO 조정표 안 common total label 중복. 시작점 FFO와 마지막 AFFO 행을 별도 문맥으로 식별해야 함.
- Table headings: Funds From Operations (FFO) / Adjusted Funds From Operations (AFFO)
- Share rows: FFO: Diluted FFO $ 170,988 $ 200,099 $ 773,542 $ 736,830; FFO per common share:; Basic $ 0.61 $ 0.77 $ 2.83 $ 2.88; Diluted $ 0.61 $ 0.77 $ 2.82 $ 2.88; Basic 281,923,090 258,373,179 273,465,680 255,066,500; Diluted 282,023,488 259,010,432 273,936,752 255,822,679 / AFFO: Diluted AFFO $ 215,605 $ 193,226 $ 839,816 $ 737,829; AFFO per common share; Basic $ 0.76 $ 0.75 $ 3.07 $ 2.89; Diluted $ 0.76 $ 0.75 $ 3.06 $ 2.88; Basic 281,923,090 258,373,179 273,465,680 255,066,500; Diluted 282,428,692 259,010,432 274,024,934 255,822,679
- Period columns: Three months ended Year ended; 2017 2016 2017 2016 / Three months ended Year ended; 2017 2016 2017 2016
- Units: (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts)
- Normalized FFO: not_reported
- Physical pages: 5, 6
- 현재 상태: NEEDS_REVIEW; DUPLICATE_LABEL

### [NEW FORMAT / REVIEW] 2018 Q1

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2018/q1/Realty-Income-Q1-2018-Supplemental-Information.pdf)
- 기존 구조와 차이 / 필요한 adapter: FFO/AFFO joint per-share + diluted total. A-J는 diluted total 없음; C는 Normalized FFO를 요구함.
- Table headings: Funds From Operations (FFO) / Adjusted Funds From Operations (AFFO)
- Share rows: FFO: Diluted FFO $ 225,100 $ 187,433; FFO per common share, basic and diluted $ 0.79 $ 0.71; Basic 283,917,418 263,340,491; Diluted 284,345,328 263,934,304 / AFFO: Diluted AFFO $ 224,789 $ 201,630; AFFO per common share, basic and diluted $ 0.79 $ 0.76; Basic 283,917,418 263,340,491; Diluted 284,345,328 264,022,486
- Period columns: Three months ended; 2018 2017 / Three months ended; 2018 2017
- Units: (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts)
- Normalized FFO: not_reported
- Physical pages: 5, 6
- 현재 상태: UNKNOWN_FORMAT; FORMAT_UNSUPPORTED

### [NEW FORMAT / REVIEW] 2018 Q2

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2018/q2/Realty-Income-Q2-2018-Supplemental-Information.pdf)
- 기존 구조와 차이 / 필요한 adapter: FFO separate / AFFO joint, Normalized FFO 없음. B-M의 joint/separate 방향과 반대.
- Table headings: Funds From Operations (FFO) / Adjusted Funds From Operations (AFFO)
- Share rows: FFO: Diluted FFO $ 226,314 $ 203,554 $ 451,414 $ 390,921; FFO per common share:; Basic $ 0.79 $ 0.75 $ 1.59 $ 1.46; Diluted $ 0.79 $ 0.75 $ 1.58 $ 1.46; Basic 284,928,969 272,588,332 284,469,689 268,024,691; Diluted 285,372,256 273,187,669 284,924,336 268,569,855 / AFFO: Diluted AFFO $ 227,224 $ 208,680 $ 452,014 $ 410,309; AFFO per common share, basic and diluted $ 0.80 $ 0.76 $ 1.59 $ 1.53; Basic 284,928,969 272,588,332 284,469,689 268,024,691; Diluted 285,372,256 273,187,669 284,924,336 268,658,037
- Period columns: Three months ended Six months ended; 2018 2017 2018 2017 / Three months ended Six months ended; 2018 2017 2018 2017
- Units: (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts)
- Normalized FFO: not_reported
- Physical pages: 5, 6
- 현재 상태: UNKNOWN_FORMAT; FORMAT_UNSUPPORTED

### [NEW FORMAT / REVIEW] 2019 Q1

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2019/q1/Realty-Income-Q1-2019-Supplemental-Information_0.pdf)
- 기존 구조와 차이 / 필요한 adapter: FFO/AFFO joint per-share + diluted total, Normalized FFO 없음.
- Table headings: Funds From Operations (FFO) / Adjusted Funds From Operations (AFFO)
- Share rows: FFO: Diluted FFO $ 245,675 $ 225,100; FFO per common share, basic and diluted $ 0.81 $ 0.79; Basic 303,528,336 283,917,418; Diluted 303,819,878 284,345,328 / AFFO: Diluted AFFO $ 248,734 $ 224,789; AFFO per common share, basic and diluted $ 0.82 $ 0.79; Basic 303,528,336 283,917,418; Diluted 303,819,878 284,345,328
- Period columns: Three months ended; 2019 2018 / Three months ended; 2019 2018
- Units: (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts)
- Normalized FFO: not_reported
- Physical pages: 5, 6
- 현재 상태: UNKNOWN_FORMAT; FORMAT_UNSUPPORTED

### [NEW FORMAT / REVIEW] 2019 Q4

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2019/q4/Realty-Income-Q4-2019-Supplemental-Information.pdf)
- 기존 구조와 차이 / 필요한 adapter: B 후보이나 FFO per common share 아래 Basic and Diluted 단일 행. 별도 Basic/Diluted 두 행과 구별 필요.
- Table headings: Funds From Operations (FFO) / Adjusted Funds From Operations (AFFO)
- Share rows: FFO: Diluted FFO $ 280,768 $ 218,216 $ 1,040,994 $ 904,124; FFO per common share:; Basic and Diluted $ 0.85 $ 0.73 $ 3.29 $ 3.12; Basic 328,565,734 297,730,206 315,837,012 289,427,430; Diluted 329,364,027 298,609,734 316,601,350 289,923,984 / AFFO: Diluted AFFO $ 282,364 $ 237,300 $ 1,051,457 $ 925,459; AFFO per common share:; Basic $ 0.86 $ 0.80 $ 3.32 $ 3.19; Diluted $ 0.86 $ 0.79 $ 3.32 $ 3.19; Basic 328,565,734 297,730,206 315,837,012 289,427,430; Diluted 329,364,027 298,609,734 316,601,350 289,923,984
- Period columns: Three Months Ended Year Ended; 2019 2018 2019 2018 / Three Months Ended Year Ended; 2019 2018 2019 2018
- Units: (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts)
- Normalized FFO: not_reported
- Physical pages: 5, 6
- 현재 상태: NEEDS_REVIEW; BASIS_AMBIGUITY

### [NEW FORMAT / REVIEW] 2020 Q1

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartly-tab-2020/Realty-Income-Q1-2020-Supplemental-Information-.pdf)
- 기존 구조와 차이 / 필요한 adapter: FFO/AFFO joint per-share + diluted total, Normalized FFO 없음.
- Table headings: Funds From Operations (FFO) / Adjusted Funds From Operations (AFFO)
- Share rows: FFO: Diluted FFO $ 277,473 $ 245,675; FFO per common share, basic and diluted $ 0.82 $ 0.81; Basic 336,624,567 303,528,336; Diluted 337,439,634 303,819,878 / AFFO: Diluted AFFO $ 297,599 $ 248,734; AFFO per common share, basic and diluted $ 0.88 $ 0.82; Basic 336,624,567 303,528,336; Diluted 337,439,634 303,819,878
- Period columns: Three Months Ended; 2020 2019 / Three Months Ended; 2020 2019
- Units: (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts)
- Normalized FFO: not_reported
- Physical pages: 5, 6
- 현재 상태: UNKNOWN_FORMAT; FORMAT_UNSUPPORTED

### [NEW FORMAT / REVIEW] 2020 Q4

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/quartly-and-annual/2020/Realty-Income-Q4-2020-Supplemental-Information-2.22.21.pdf)
- 기존 구조와 차이 / 필요한 adapter: B 후보이나 FFO의 Basic and Diluted 단일 행 구조.
- Table headings: Funds From Operations(1) / Adjusted Funds From Operations(1)
- Share rows: FFO: Diluted FFO $ 294,055 $ 280,768 $ 1,143,537 $ 1,040,994; FFO per common share:; Basic and diluted $ 0.83 $ 0.85 $ 3.31 $ 3.29; Basic 354,437,466 328,565,734 345,280,126 315,837,012; Diluted 355,050,977 329,364,027 345,878,377 316,601,350 / AFFO: Diluted AFFO $ 298,013 $ 282,364 $ 1,174,064 $ 1,051,457; AFFO per common share:; Basic $ 0.84 $ 0.86 $ 3.40 $ 3.32; Diluted $ 0.84 $ 0.86 $ 3.39 $ 3.32; Basic 354,437,466 328,565,734 345,280,126 315,837,012; Diluted 355,050,977 329,364,027 345,878,377 316,601,350
- Period columns: Three Months Ended December 31, Year Ended December 31,; 2020 2019 2020 2019 / Three Months Ended December 31, Year Ended December 31,; 2020 2019 2020 2019; accounted for as modifications totaling $12,000 and $236,000 for the three months and year ended December 31, 2020, respectively, have not been added back to AFFO.
- Units: (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts)
- Normalized FFO: not_reported
- Physical pages: 9, 10
- 현재 상태: NEEDS_REVIEW; BASIS_AMBIGUITY

### [NEW FORMAT / REVIEW] 2021 Q1

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/quartly-and-annual/2021/Realty-Income-Q1-2021-Supplemental-Information-new.pdf)
- 기존 구조와 차이 / 필요한 adapter: B 후보이나 FFO의 Basic and Diluted 단일 행 구조. Normalized FFO 미공시.
- Table headings: Funds From Operations(1) / Adjusted Funds From Operations(1)
- Share rows: FFO: Diluted FFO $ 267,707 $ 277,473; FFO per common share:; Basic and diluted $ 0.72 $ 0.82; Basic 371,522,607 336,624,567; Diluted 371,601,901 337,439,634 / AFFO: Diluted AFFO $ 318,573 $ 297,599; AFFO per common share:; Basic and diluted $ 0.86 $ 0.88; Basic 371,522,607 336,624,567; Diluted 372,065,020 337,439,634
- Period columns: Three Months Ended March 31,; 2021 2020 / Three Months Ended March 31,; 2021 2020; pandemic did not affect our rent collections until April 2020, there was no related impact for the three months ended March 31, 2020.
- Units: (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts)
- Normalized FFO: not_reported
- Physical pages: 7, 8
- 현재 상태: NEEDS_REVIEW; BASIS_AMBIGUITY

### [NEW FORMAT / REVIEW] 2021 Q3

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/quartly-and-annual/2021/Realty-Income-Q3-2021-Supplemental-Information-11.1.21-new.pdf)
- 기존 구조와 차이 / 필요한 adapter: C-M 구조 후보. Normalized FFO 정의의 proposed merger 문구가 merger 문구로 바뀜. 기존 정의 자동 재사용 금지.
- Table headings: FFO and Normalized FFO (1) / AFFO (1)
- Share rows: FFO: Diluted FFO $ 332,691 $ 283,323 $ 915,479 $ 849,482; Diluted Normalized FFO $ 349,474 $ 283,323 $ 945,560 $ 849,482; FFO per common share, basic and diluted $ 0.85 $ 0.82 $ 2.41 $ 2.48; Normalized FFO per common share, basic and diluted $ 0.89 $ 0.82 $ 2.49 $ 2.48; Basic 391,913,478 346,476,217 379,291,782 342,214,164; Diluted 392,513,520 347,212,593 379,872,546 342,946,337 / AFFO: Diluted AFFO $ 357,188 $ 282,856 $ 1,003,753 $ 876,051; AFFO per common share:; Basic $ 0.91 $ 0.82 $ 2.64 $ 2.56; Diluted $ 0.91 $ 0.81 $ 2.64 $ 2.55; Basic 391,913,478 346,476,217 379,291,782 342,214,164; Diluted 392,513,520 347,212,593 379,872,546 342,946,337
- Period columns: Three Months Ended September 30, Nine Months Ended September 30,; 2021 2020 2021 2020 / Three Months Ended September 30, Nine Months Ended September 30,; 2021 2020 2021 2020
- Units: (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts)
- Normalized FFO: 공시
- Physical pages: 7, 8
- 현재 상태: NEEDS_REVIEW; DEFINITION_UNKNOWN

### [NEW FORMAT / REVIEW] 2021 Q4

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/quartely-and-annual-result/year-2021/Realty-Income-Q4-2021-Supplemental-Information.pdf)
- 기존 구조와 차이 / 필요한 adapter: FFO joint / Normalized FFO separate / AFFO separate. 현재 joint FFO면 joint Normalized FFO로 해석하는 규칙에 맞지 않음.
- Table headings: FFO and Normalized FFO (1) / AFFO (1)
- Share rows: FFO: Diluted FFO $ 326,163 $ 294,055 $ 1,240,580 $ 1,143,537; Diluted Normalized FFO $ 463,495 $ 294,055 $ 1,409,635 $ 1,143,537; FFO per common share, basic and diluted $ 0.63 $ 0.83 $ 2.99 $ 3.31; Normalized FFO per common share:; Basic $ 0.89 $ 0.83 $ 3.40 $ 3.31; Diluted $ 0.89 $ 0.83 $ 3.39 $ 3.31; Basic 519,116,544 354,437,466 414,535,283 345,280,126; Diluted 519,438,347 355,050,977 414,769,846 345,878,377; Basic 519,116,544 354,437,466 414,535,283 345,280,126; Diluted 519,438,347 355,050,977 415,270,063 345,878,377 / AFFO: Diluted AFFO $ 486,047 $ 298,013 $ 1,490,372 $ 1,174,064; AFFO per common share:; Basic $ 0.94 $ 0.84 $ 3.59 $ 3.40; Diluted $ 0.94 $ 0.84 $ 3.59 $ 3.39; Basic 519,116,544 354,437,466 414,535,283 345,280,126; Diluted 519,438,347 355,050,977 415,270,063 345,878,377
- Period columns: Three Months Ended December 31, Year Ended December 31,; 2021 2020 2021 2020 / Three Months Ended December 31, Year Ended December 31,; 2021 2020 2021 2020
- Units: (in thousands, except per share and share count data) / (in thousands, except per share and share count data)
- Normalized FFO: 공시
- Physical pages: 7, 8
- 현재 상태: NEEDS_REVIEW; BASIS_AMBIGUITY

### [NEW FORMAT / REVIEW] 2022 Q4

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/investors/realty-income-q4-2022-supplemental-information-2-21-23.pdf)
- 기존 구조와 차이 / 필요한 adapter: FFO joint / Normalized FFO separate / AFFO separate. 주당값·가중주식수의 metric별 문맥 구분 필요.
- Table headings: FFO and Normalized FFO (1) / AFFO (1)
- Share rows: FFO: Diluted FFO $ 665,918 $ 326,163 $ 2,475,872 $ 1,240,580; Diluted Normalized FFO $ 666,821 $ 463,495 $ 2,489,769 $ 1,409,635; FFO per common share, basic and diluted $ 1.05 $ 0.63 $ 4.04 $ 2.99; Normalized FFO per common share; Basic $ 1.05 $ 0.89 $ 4.06 $ 3.40; Diluted $ 1.05 $ 0.89 $ 4.06 $ 3.39; Basic 633,373,847 519,116,544 611,765,815 414,535,283; Diluted 635,637,335 519,438,347 613,472,663 414,769,846; Basic 633,373,847 519,116,544 611,765,815 414,535,283; Diluted 635,637,335 519,438,347 613,472,663 415,270,063 / AFFO: Diluted AFFO $ 635,387 $ 486,047 $ 2,405,392 $ 1,490,372; AFFO per common share; Basic $ 1.00 $ 0.94 $ 3.93 $ 3.59; Diluted $ 1.00 $ 0.94 $ 3.92 $ 3.59; Basic 633,373,847 519,116,544 611,765,815 414,535,283; Diluted 635,637,335 519,438,347 613,472,663 415,270,063
- Period columns: Three Months Ended December 31, Years ended December 31,; 2022 2021 2022 2021 / Three Months Ended December 31, Years ended December 31,; 2022 2021 2022 2021
- Units: (in thousands, except per share and share count data) / (in thousands, except per share and share count data)
- Normalized FFO: 공시
- Physical pages: 5, 6
- 현재 상태: UNKNOWN_FORMAT; FORMAT_UNSUPPORTED

### [NEW FORMAT / REVIEW] 2023 Q1

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2023-05/realty-income-q1-2023-supplemental-information.pdf)
- 기존 구조와 차이 / 필요한 adapter: FFO separate / Normalized FFO joint / AFFO separate. D의 mixed 방향과 다름.
- Table headings: FFO and Normalized FFO (1) / AFFO (1)
- Share rows: FFO: Diluted FFO $ 685,711 $ 602,224; Diluted Normalized FFO $ 687,018 $ 608,743; FFO per common share; Basic $ 1.04 $ 1.01; Diluted $ 1.03 $ 1.01; Normalized FFO per common share, basic and diluted $ 1.04 $ 1.02; Basic 660,462,399 593,827,299; Diluted 663,034,011 595,102,548 / AFFO: Diluted AFFO $ 652,159 $ 580,918; AFFO per common share; Basic $ 0.99 $ 0.98; Diluted $ 0.98 $ 0.98; Basic 660,462,399 593,827,299; Diluted 663,034,011 595,102,548
- Period columns: Three Months Ended March 31,; 2023 2022 / Three Months Ended March 31,; 2023 2022
- Units: (in thousands, except per share and share count data) / (in thousands, except per share and share count data)
- Normalized FFO: 공시
- Physical pages: 5, 6
- 현재 상태: UNKNOWN_FORMAT; FORMAT_UNSUPPORTED

### [NEW FORMAT / REVIEW] 2023 Q2

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2023-07/Realty%20Income%20Q2%202023%20Supplemental%20Information%20Final%20Compressed.pdf)
- 기존 구조와 차이 / 필요한 adapter: FFO separate / Normalized FFO joint / AFFO separate. share count 단위가 thousands로 전환됨.
- Table headings: FFO and Normalized FFO (1) / AFFO (1)
- Share rows: FFO: Diluted FFO $ 689,356 $ 609,591 $ 1,375,067 $ 1,211,815; Diluted Normalized FFO $ 689,697 $ 612,320 $ 1,376,715 $ 1,221,063; FFO per common share; Basic $ 1.02 $ 1.01 $ 2.06 $ 2.02; Diluted $ 1.02 $ 1.01 $ 2.05 $ 2.02; Normalized FFO per common share, basic and diluted $ 1.02 $ 1.02 $ 2.06 $ 2.04; Basic 674,109 601,672 667,357 597,778; Diluted 676,388 603,091 669,903 599,201 / AFFO: Diluted AFFO $ 673,119 $ 584,515 $ 1,325,279 $ 1,165,433; AFFO per common share; Basic $ 1.00 $ 0.97 $ 1.98 $ 1.95; Diluted $ 1.00 $ 0.97 $ 1.98 $ 1.94; Basic 674,109 601,672 667,357 597,778; Diluted 676,388 603,091 669,903 599,201
- Period columns: Three months ended Six months ended; 2023 2022 2023 2022 / Three months ended Six months ended; 2023 2022 2023 2022
- Units: (in thousands, except per share amounts) / (in thousands, except per share amounts)
- Normalized FFO: 공시
- Physical pages: 5, 6
- 현재 상태: UNKNOWN_FORMAT; FORMAT_UNSUPPORTED

### [NEW FORMAT / REVIEW] 2023 Q4

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/realty-income/quartly-and-annual/realty-income-q4-2023-supplemental-information.pdf)
- 기존 구조와 차이 / 필요한 adapter: FFO / Normalized FFO / AFFO 모두 separate. 현재 generation은 이 조합 미지원.
- Table headings: FFO and Normalized FFO (1) / AFFO (1)
- Share rows: FFO: Diluted FFO $ 715,102 $ 665,918 $ 2,827,690 $ 2,475,872; Diluted Normalized FFO $ 725,034 $ 666,821 $ 2,842,154 $ 2,489,769; FFO per common share; Basic $ 0.98 $ 1.05 $ 4.08 $ 4.04; Diluted $ 0.98 $ 1.05 $ 4.07 $ 4.04; Normalized FFO per common share; Basic $ 1.00 $ 1.05 $ 4.10 $ 4.06; Diluted $ 1.00 $ 1.05 $ 4.09 $ 4.06; Basic 724,598 633,374 692,298 611,766; Diluted 726,859 635,637 694,819 613,473 / AFFO: Diluted AFFO $ 732,404 $ 635,387 $ 2,780,410 $ 2,405,392; AFFO per common share; Basic $ 1.01 $ 1.00 $ 4.01 $ 3.93; Diluted $ 1.01 $ 1.00 $ 4.00 $ 3.92; Basic 724,598 633,374 692,298 611,766; Diluted 726,859 635,637 694,819 613,473
- Period columns: Three months ended December 31, Years ended December 31,; 2023 2022 2023 2022 / Three months ended December 31, Years ended December 31,; 2023 2022 2023 2022
- Units: (in thousands, except per share amounts) / (in thousands, except per share amounts)
- Normalized FFO: 공시
- Physical pages: 5, 6
- 현재 상태: UNKNOWN_FORMAT; FORMAT_UNSUPPORTED

### [NEW FORMAT / REVIEW] 2024 Q1

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2024-05/Realty_Income_Q1_2024_Supplemental_Information_FINAL.pdf)
- 기존 구조와 차이 / 필요한 adapter: FFO separate / Normalized FFO joint / AFFO separate. D와 다른 조합.
- Table headings: FFO and Normalized FFO (1) / AFFO (1)
- Share rows: FFO: Diluted FFO $ 787,023 $ 685,711; Diluted Normalized FFO $ 881,127 $ 687,018; FFO per common share; Basic $ 0.94 $ 1.04; Diluted $ 0.94 $ 1.03; Normalized FFO per common share, basic and diluted $ 1.05 $ 1.04; Basic 834,940 660,462; Diluted 837,037 663,034 / AFFO: Diluted AFFO $ 864,230 $ 652,159; AFFO per common share; Basic $ 1.03 $ 0.99; Diluted $ 1.03 $ 0.98; Basic 834,940 660,462; Diluted 837,037 663,034
- Period columns: Three months ended March 31,; 2024 2023 / Three months ended March 31,; 2024 2023
- Units: (in thousands, except per share amounts) / (in thousands, except per share amounts)
- Normalized FFO: 공시
- Physical pages: 5, 6
- 현재 상태: UNKNOWN_FORMAT; FORMAT_UNSUPPORTED

### [NEW FORMAT / REVIEW] 2024 Q3

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2024-11/realty-income-q3-2024-supplemental-information.pdf)
- 기존 구조와 차이 / 필요한 adapter: FFO joint / Normalized FFO separate / AFFO separate + unaudited 단위 제목. merger/transaction 및 AFFO 조정항목 변화도 정의 후보 조사 필요.
- Table headings: FFO and Normalized FFO (1) / AFFO (1)
- Share rows: FFO: Diluted FFO $ 856,393 $ 737,521 $ 2,574,144 $ 2,112,588; Diluted Normalized FFO $ 865,003 $ 740,405 $ 2,679,612 $ 2,117,120; FFO per common share, basic and diluted: $ 0.98 $ 1.04 $ 2.99 $ 3.09; Normalized FFO per common share:; Basic $ 0.99 $ 1.04 $ 3.12 $ 3.10; Diluted $ 0.99 $ 1.04 $ 3.11 $ 3.10; Basic 870,665 709,165 858,679 681,419; Diluted 873,974 711,338 861,300 683,925 / AFFO: Diluted AFFO $ 917,039 $ 722,727 $ 2,703,930 $ 2,048,006; AFFO per common share:; Basic $ 1.05 $ 1.02 $ 3.14 $ 3.00; Diluted $ 1.05 $ 1.02 $ 3.14 $ 2.99; Basic 870,665 709,165 858,679 681,419; Diluted 873,974 711,338 861,300 683,925
- Period columns: Three months ended Nine months ended; 2024 2023 2024 2023; (2) During the three and nine months ended September 30, 2024, we incurred $8.6 million and $105.5 million, respectively, of merger, transaction, and other costs consisting primarily of / Three months ended Nine months ended; 2024 2023 2024 2023
- Units: (in thousands, except per share amounts) (unaudited) / (in thousands, except per share amounts) (unaudited)
- Normalized FFO: 공시
- Physical pages: 5, 6
- 현재 상태: UNKNOWN_FORMAT; FORMAT_UNSUPPORTED

### [NEW FORMAT / REVIEW] 2024 Q4

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2025-02/realty-income-q4-2024-supplemental-information.pdf)
- 기존 구조와 차이 / 필요한 adapter: 세 metric 모두 separate + unaudited 단위 제목. 조정항목·정의 변경 후보 확인 필요.
- Table headings: FFO and Normalized FFO (1) / AFFO (1)
- Share rows: FFO: Diluted FFO $ 900,126 $ 715,102 $ 3,474,270 $ 2,827,690; Diluted Normalized FFO $ 890,950 $ 725,034 $ 3,570,562 $ 2,842,154; FFO per common share:; Basic $ 1.03 $ 0.98 $ 4.02 $ 4.08; Diluted $ 1.02 $ 0.98 $ 4.01 $ 4.07; Normalized FFO per common share:; Basic $ 1.01 $ 1.00 $ 4.13 $ 4.10; Diluted $ 1.01 $ 1.00 $ 4.12 $ 4.09; Basic 875,710 724,598 862,959 692,298; Diluted 879,649 726,859 865,842 694,819 / AFFO: Diluted AFFO $ 924,106 $ 732,404 $ 3,628,036 $ 2,780,410; AFFO per common share:; Basic $ 1.05 $ 1.01 $ 4.20 $ 4.01; Diluted $ 1.05 $ 1.01 $ 4.19 $ 4.00; Basic 875,710 724,598 862,959 692,298; Diluted 879,649 726,859 865,842 694,819
- Period columns: Three months ended Years ended; 2024 2023 2024 2023; (2) For the three months ended December 31, 2024, merger, transaction, and other costs, net primarily consists of a $13.1 million adjustment to transfer taxes related to the merger with Spirit; Realty Capital, Inc. ("Spirit") and $3.9 million of organization costs related to the private fund. For the year ended December 31, 2024, merger, transaction, and other costs, net primarily / Three months ended Years ended; 2024 2023 2024 2023
- Units: (in thousands, except per share amounts) (unaudited) / (in thousands, except per share amounts) (unaudited)
- Normalized FFO: 공시
- Physical pages: 5, 6
- 현재 상태: UNKNOWN_FORMAT; FORMAT_UNSUPPORTED

### [NEW FORMAT / REVIEW] 2025 Q1

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2025-05/Realty_Income_Earnings_Release_and_Supplemental_Information_Q1_2025.pdf)
- 기존 구조와 차이 / 필요한 adapter: 통합 earnings/supplemental/appendix PDF. 물리 32/33쪽과 인쇄 15/16쪽 구별; (1) 각주 위치, USD and shares 단위, 추가 조정항목. 기존 SEC HTML adapter로 강제하지 않음.
- Table headings: (1) / (1)
- Share rows: FFO: Diluted FFO 940,080 787,023; Diluted Normalized FFO 940,359 881,127; FFO per common share, basic and diluted 1.05 0.94; Normalized FFO per common share, basic and diluted 1.05 1.05; Basic 891,666 834,940; Diluted 895,033 837,037 / AFFO: Diluted AFFO 952,117 864,230; AFFO per common share:; Basic 1.07 1.03; Diluted 1.06 1.03; Basic 891,666 834,940; Diluted 895,033 837,037
- Period columns: Three months ended March 31,; 2025 2024 / Three months ended March 31,; 2025 2024
- Units: (USD and shares in thousands, except per share amounts) (unaudited) / (USD and shares in thousands, except per share amounts) (unaudited)
- Normalized FFO: 공시
- Physical pages: 32, 33
- 현재 상태: UNKNOWN_FORMAT; TABLE_AMBIGUITY

### [NEW FORMAT / REVIEW] 2025 Q2

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2025-08/realty-income-earnings-release-and-supplemental-information-q2-2025.pdf)
- 기존 구조와 차이 / 필요한 adapter: 통합 PDF 물리 33/34쪽. 양쪽 joint per-share, 새 단위/표 제목/본문 정의 위치 및 반복 appendix 분리 필요.
- Table headings: (1) / (1)
- Share rows: FFO: Diluted FFO 958,165 930,728 1,898,245 1,717,751; Diluted Normalized FFO 958,496 933,482 1,898,855 1,814,609; FFO per common share, basic and diluted 1.06 1.07 2.11 2.01; Normalized FFO per common share, basic and diluted 1.06 1.07 2.11 2.12; Basic 902,966 870,319 897,338 852,621; Diluted 906,398 872,520 900,797 854,806 / AFFO: Diluted AFFO 949,892 922,661 1,902,009 1,786,891; AFFO per common share, basic and diluted 1.05 1.06 2.11 2.09; Basic 902,966 870,319 897,338 852,621; Diluted 906,398 872,520 900,797 854,806
- Period columns: Three months ended June 30, Six months ended June 30,; 2025 2024 2025 2024 / Three months ended June 30, Six months ended June 30,; 2025 2024 2025 2024
- Units: (USD and shares in thousands, except per share amounts) (unaudited) / (USD and shares in thousands, except per share amounts) (unaudited)
- Normalized FFO: 공시
- Physical pages: 33, 34
- 현재 상태: UNKNOWN_FORMAT; TABLE_AMBIGUITY

### [NEW FORMAT / REVIEW] 2025 Q3

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2025-11/realty-income-earnings-release-and-supplemental-information-q3-2025.pdf)
- 기존 구조와 차이 / 필요한 adapter: 통합 PDF 물리 33/34쪽. FFO joint / Normalized FFO separate / AFFO joint, 새 단위와 조정항목.
- Table headings: FFO and Normalized FFO(1) / AFFO(1)
- Share rows: FFO: Diluted FFO 983,396 856,393 2,881,641 2,574,144; Diluted Normalized FFO 996,739 865,003 2,895,594 2,679,612; FFO per common share, basic and diluted 1.07 0.98 3.18 2.99; Normalized FFO per common share:; Basic 1.09 0.99 3.20 3.12; Diluted 1.09 0.99 3.19 3.11; Basic 913,949 870,665 902,935 858,679; Diluted 917,869 873,974 906,692 861,300 / AFFO: Diluted AFFO 994,319 917,039 2,896,328 2,703,930; AFFO per common share:; Basic 1.09 1.05 3.20 3.14; Diluted 1.08 1.05 3.19 3.14; Basic 913,949 870,665 902,935 858,679; Diluted 917,869 873,974 906,692 861,300
- Period columns: Three months ended September 30, Nine months ended September 30,; 2025 2024 2025 2024; (2) During the three and nine months ended September 30, 2025, we incurred $13.3 million and $14.0 million, respectively, of merger, transaction, and other costs, consisting primarily of placement fees / Three months ended September 30, Nine months ended September 30,; 2025 2024 2025 2024
- Units: (USD and shares in thousands, except per share amounts) (unaudited) / (USD and shares in thousands, except per share amounts) (unaudited)
- Normalized FFO: 공시
- Physical pages: 33, 34
- 현재 상태: UNKNOWN_FORMAT; TABLE_AMBIGUITY

### [NEW FORMAT / REVIEW] 2025 Q4

- Source: [공식 PDF](https://www.realtyincome.com/sites/realty-income/files/2026-02/q4-2025-supplemental-report.pdf)
- 기존 구조와 차이 / 필요한 adapter: 통합 PDF 물리 34/35쪽. 세 metric separate, Q4와 FY 열 쌍, 새 단위와 조정항목.
- Table headings: FFO and Normalized FFO(1) / AFFO(1)
- Share rows: FFO: Diluted FFO 988,078 900,126 3,869,719 3,474,270; Diluted Normalized FFO 998,339 890,950 3,893,933 3,570,562; FFO per common share:; Basic 1.07 1.03 4.26 4.02; Diluted 1.07 1.02 4.25 4.01; Normalized FFO per common share:; Basic 1.08 1.01 4.28 4.13; Diluted 1.08 1.01 4.27 4.12; Basic 919,769 875,710 907,169 862,959; Diluted 923,648 879,649 911,015 865,842 / AFFO: Diluted AFFO 998,893 924,106 3,895,221 3,628,036; AFFO per common share:; Basic 1.08 1.05 4.28 4.20; Diluted 1.08 1.05 4.28 4.19; Basic 919,769 875,710 907,169 862,959; Diluted 923,648 879,649 911,015 865,842
- Period columns: Three months ended December 31, Years ended December 31,; 2025 2024 2025 2024; (2) During the three months and year ended December 31, 2025, we incurred $10.3 million and $24.2 million, respectively, of merger, transaction, and other costs, net, consisting primarily of placement fees / Three months ended December 31, Years ended December 31,; 2025 2024 2025 2024
- Units: (USD and shares in thousands, except per share amounts) (unaudited) / (USD and shares in thousands, except per share amounts) (unaudited)
- Normalized FFO: 공시
- Physical pages: 34, 35
- 현재 상태: UNKNOWN_FORMAT; TABLE_AMBIGUITY

# 부록 B — 40개 Unit Audit

| 기간 | raw currency | raw unit labels | 승인 multiplier | weighted share count unit | 승인 per-share unit | 단위 지원 |
| --- | --- | --- | --- | --- | --- | --- |
| 2016-q1 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands , except per share amounts) | 미정규화 | 미정규화 | 미정규화 | NO |
| 2016-q2 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2016-q3 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2016-q4 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2017-q1 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2017-q2 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2017-q3 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2017-q4 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2018-q1 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2018-q2 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2018-q3 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2018-q4 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2019-q1 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2019-q2 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2019-q3 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2019-q4 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2020-q1 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2020-q2 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2020-q3 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2020-q4 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2021-q1 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2021-q2 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2021-q3 | USD | (dollars in thousands, except per share amounts) / (dollars in thousands, except per share amounts) | 1000 | shares / shares | USD/share | YES |
| 2021-q4 | USD | (in thousands, except per share and share count data) / (in thousands, except per share and share count data) | 1000 | shares / shares | USD/share | YES |
| 2022-q1 | USD | (in thousands, except per share and share count data) / (in thousands, except per share and share count data) | 1000 | shares / shares | USD/share | YES |
| 2022-q2 | USD | (in thousands, except per share and share count data) / (in thousands, except per share and share count data) | 1000 | shares / shares | USD/share | YES |
| 2022-q3 | USD | (in thousands, except per share and share count data) / (in thousands, except per share and share count data) | 1000 | shares / shares | USD/share | YES |
| 2022-q4 | USD | (in thousands, except per share and share count data) / (in thousands, except per share and share count data) | 1000 | shares / shares | USD/share | YES |
| 2023-q1 | USD | (in thousands, except per share and share count data) / (in thousands, except per share and share count data) | 1000 | shares / shares | USD/share | YES |
| 2023-q2 | USD | (in thousands, except per share amounts) / (in thousands, except per share amounts) | 1000 | shares thousand / shares thousand | USD/share | YES |
| 2023-q3 | USD | (in thousands, except per share amounts) / (in thousands, except per share amounts) | 1000 | shares thousand / shares thousand | USD/share | YES |
| 2023-q4 | USD | (in thousands, except per share amounts) / (in thousands, except per share amounts) | 1000 | shares thousand / shares thousand | USD/share | YES |
| 2024-q1 | USD | (in thousands, except per share amounts) / (in thousands, except per share amounts) | 1000 | shares thousand / shares thousand | USD/share | YES |
| 2024-q2 | USD | (in thousands, except per share amounts) / (in thousands, except per share amounts) | 1000 | shares thousand / shares thousand | USD/share | YES |
| 2024-q3 | USD | (in thousands, except per share amounts) (unaudited) / (in thousands, except per share amounts) (unaudited) | 미정규화 | 미정규화 | 미정규화 | NO |
| 2024-q4 | USD | (in thousands, except per share amounts) (unaudited) / (in thousands, except per share amounts) (unaudited) | 미정규화 | 미정규화 | 미정규화 | NO |
| 2025-q1 | USD | (USD and shares in thousands, except per share amounts) (unaudited) / (USD and shares in thousands, except per share amounts) (unaudited) | 미정규화 | 미정규화 | 미정규화 | NO |
| 2025-q2 | USD | (USD and shares in thousands, except per share amounts) (unaudited) / (USD and shares in thousands, except per share amounts) (unaudited) | 미정규화 | 미정규화 | 미정규화 | NO |
| 2025-q3 | USD | (USD and shares in thousands, except per share amounts) (unaudited) / (USD and shares in thousands, except per share amounts) (unaudited) | 미정규화 | 미정규화 | 미정규화 | NO |
| 2025-q4 | USD | (USD and shares in thousands, except per share amounts) (unaudited) / (USD and shares in thousands, except per share amounts) (unaudited) | 미정규화 | 미정규화 | 미정규화 | NO |

# 부록 C — 40개 Source Hash / Date / Page

| 기간 | SHA-256 | SEC 공개일(원문 명시) | physical pages | hash changed |
| --- | --- | --- | --- | --- |
| 2016-q1 | 55469622981fa3b76d11b0c0b2b64e7806c34a8b8ee223d82583f5f7c1e2798d | 2016-04-26 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2016-q2 | 5382cb1c92ee25b19bac2ac3a1ecf41b579833d744449363340e15df048854f1 | 2016-07-27 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2016-q3 | 063b13a42d2a04e66938d9f125a4b70092b5ce2f9c5b77ea35860437b671e927 | 2016-10-26 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2016-q4 | f989d35506f2f0bf1b6a17d24865ca5d87ae770aa7273458373ae313e3900d10 | 2017-02-22 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2017-q1 | 9ce4f079b00bcfec93973f52379997b39c574c8562026862aa6515cd2be66824 | 2017-04-25 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2017-q2 | 760253a5528e0a9ab9cae466131aa69f0b2da6b7fdcd5e0c0734b08051c2008d | 2017-07-26 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2017-q3 | 78ff55288371e4fa02207798a3839985cef0f8aea2e7eb8f35462bc20515fd10 | 2017-10-25 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2017-q4 | 9271642af031129aaaad1aca0687a3826f3740319024e0877af61a5c13c864ea | 2018-02-21 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2018-q1 | fa6936d9d64f0a2aa08ed287f2202f75b2b5b8d0d722ad1573f3f8fddaa164df | 2018-05-08 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2018-q2 | 4a3da96e69c9d8af0709561d560c243aa5d96e901287348f9e42ad055b47089a | 2018-08-01 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2018-q3 | ac491097b42cc7545bab373213b32ae3766bc7aaa40208faceed9185e9f9a853 | 2018-10-31 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2018-q4 | e214f67fd87423ea4efcc82a2d97c784c35937a167f161ae12016f70a3e9cce2 | 2019-02-20 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2019-q1 | 1854d98f10be8a5f93dc1f1f1c295ddcb105c49b528fc032f9c75088a55fb3b3 | 2019-05-01 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2019-q2 | 9dd38670e6a33f5b00c50a3c05ae936010a8eac16fb53e667ea08d099517be99 | 2019-08-05 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2019-q3 | 6230d56ebb347957a63f8ba544f9403c0b14ddeedb7572cd9fe9926917760981 | 2019-11-04 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2019-q4 | 5efad6af715c96c0750ec3a24f0369cc10f1a9c0843689f64a45b6026212f7da | 2020-02-19 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2020-q1 | fcb438de9e12dfc11a63d5f6d5b2c971d46342b5233a18ed060cdbb86f753eb6 | 2020-05-04 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2020-q2 | 07ef77962a05159c2cf78af3e9344ad6e4b8034efac5f7585078517416c00d79 | 2020-08-03 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2020-q3 | c6997a2b155d46c6a81c5a173cf2932efad493fa474f3406be6b9406734d9873 | 2020-11-02 | 9, 10 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2020-q4 | 7c4c9738f401d11cfff227012cb89ca26afb1e8c23c619f9e408485ce685c127 | 2021-02-22 | 9, 10 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2021-q1 | 23db5c2ff9f79fb148ae283140f845a42972d14f2ad51bf4cf413b8c647707ef | 2021-05-03 | 7, 8 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2021-q2 | 06dc21dacc3f3df5e9d595333502f8619bfdea730931f249e6b00b6bb2a95cd1 | 2021-08-02 | 7, 8 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2021-q3 | d396c280c95f64579dcf9ac6ca3916edc8626a76df5439e77733dfaf3192dfd2 | 2021-11-01 | 7, 8 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2021-q4 | 51b1139d20bad8a53dbd065629652b818425ace6fa9c60df4a1cf258baa7f696 | 2022-02-22 | 7, 8 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2022-q1 | 594ce150c695a369a896be2fd25f4022330bda2ab7baa30fc5234713bdfc9f29 | 2022-05-04 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2022-q2 | 019cc8ac51bd4d83d3cebefa6df4488c36e23896550d44085f16f541600601e8 | 2022-08-03 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2022-q3 | 4e551b580d2217f1458914aad565d99d7c2ccc4627c8a59d2607c57b7d90894e | 2022-11-02 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2022-q4 | 3d8dee71ecf340545763f3173ea6ab2ab74ee43cf41ff874c9c561870823fad8 | 2023-02-21 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2023-q1 | 4be46a4e492faf44d790ea0e863c551eab3ae7d0ef50b5e5c2ec13216b87e884 | 2023-05-03 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2023-q2 | b03aba23a8a0a887d38d2614556b4d31abd3b127d37a3ebe0f224e6bc6fb9bb0 | 2023-08-02 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2023-q3 | 75137a255c8db2ee2b6acc63c8386e772531c1beb28edd4d64efbd08e72c0dd2 | 2023-11-06 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2023-q4 | c66653ef9ad07904e80a2b36d3c18d453f894a388fb432e3cbbe3c3ed7b71fa0 | 2024-02-20 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2024-q1 | 7e444de79246610797dabbd26b3fb843f701a32d2f7b8461e1aea83d4fcace86 | 2024-05-06 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2024-q2 | ef66aa6179989a4b0f2ab22478601210f440274efa1756fd82ea7db19e0969db | 2024-08-05 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2024-q3 | c27b8b1de2aa0bc0e86d1ca043b05e3cf1fcc9bbeb4223e32347e4d6cfda450a | 2024-11-04 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2024-q4 | a0b3bf067c7b19ebde01ceaac3ecb172ed6a4c7084eeabe276ad1d4599c62a3f | 2025-02-24 | 5, 6 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2025-q1 | b2835a976057a763b31ea4b06c220d470e92d316366667b40a01937df987d205 | 2025-05-05 | 32, 33 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2025-q2 | e05a8dbb939afdcb6fd6db8f1c9044dac32eb6e5b14699f9c54f89e284b82779 | 2025-08-06 | 33, 34 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2025-q3 | 130f6d5683546037dab5f9bb979f196f5aebd77b9d66dabbab8b4566251c0c12 | 2025-11-03 | 33, 34 | NO (기존 9개 비교; 신규는 최초 기준) |
| 2025-q4 | d662d229fa046c830d8e6fb1f87da72638d1560148fed387ebc4abcd06913635 | 2026-02-24 | 34, 35 | NO (기존 9개 비교; 신규는 최초 기준) |

# 부록 D — 문서별 미공시 basis

FFO/AFFO의 diluted total: 2016 Q1/Q2/Q3/Q4, 2017 Q1/Q2/Q3는 not_reported. Normalized FFO의 모든 basis: 2016 Q1–2021 Q1은 not_reported. 나머지 common total/basic-share/diluted-share는 각 표의 명시적 행 존재를 조사했다. 이 조사는 numeric parsing 성공이나 adapter 승인과 별개다. 문서별 basis_disclosure는 결과 JSON 참조.
