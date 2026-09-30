# Phase P1 회사 Analysis Profile 분류 기반 구현 보고서

## 1. 시작 상태

- 기준 checkpoint: `ae4d8e1d81665a433071d7e49f938570da1878f9`, `Extend financial metric charts`.
- 시작 Git 상태: clean.
- 시작 검증: 기존 175 PASS / 0 FAIL, `npm run check` 및 `git diff --check` PASS.
- 이번 작업은 로컬 분류 기반 구현만 수행했다. 운영 변경은 없다.

## 2. Classification 구조

`worker/src/company-classification.js`에 Enum, 순수 분류 함수, 저장 statement, 읽기 전용 API adapter, 내부 Override 함수를 모았다.

지원 Profile: `GENERAL`, `REIT`, `BANK`, `EXCHANGE`, `UNKNOWN`.
`rule_version=1`. 현재 실제 저장된 `sector`와 `industry`만 판단에 사용한다.
재무값·누락 여부·ticker·상장 거래소·존재하지 않는 SIC/security type은 판정에 사용하지 않는다.

## 3. 생성 Migration

`worker/migrations/0017_company_classification.sql`을 추가했다. 기존 0001~0016은 수정하지 않았다.
회사·재무 자료를 갱신하거나 분류 seed를 생성하지 않는다. 분류는 회사정보 sync 또는 명시적인 로컬 분류 작업에서 저장한다.

## 4. company_classification Schema

| 컬럼 | 의미 |
|---|---|
| `ticker` | 현재 companies PK를 참조하는 PK/FK, 회사 삭제 시 분류 삭제 |
| `company_cik` | companies에 존재하는 CIK의 보조 식별자 복사, 없는 값은 NULL |
| `auto_profile` | 자동 판정 Profile |
| `effective_profile` | Override가 있으면 Override, 없으면 자동 Profile |
| `source_sector`, `source_industry` | 판정 입력 원본 |
| `classification_reason` | 자동 판정 이유 |
| `confidence` | 명확한 규칙은 high, 미확정·충돌은 low |
| `rule_version` | 양의 정수 규칙 버전 |
| `manual_override`, `manual_override_reason` | 수동 지정 Profile과 필수 이유 |
| `review_status` | classified / needs_review / overridden |
| `classified_at`, `updated_at` | 자동 판정 및 최종 갱신 시각 |

Enum, Override 이유, effective 일관성, review 상태, FK를 SQLite CHECK/FK로 검증한다.
Profile/review 및 CIK 조회 index를 추가했다.
CIK는 복수 share class에 공유될 수 있으므로 UNIQUE로 취급하지 않는다.
향후 ticker 변경·회사 identity 연결은 별도 migration에서 설계하며 이번에는 기존 PK를 바꾸지 않았다.

## 5. 자동 판정 규칙

- 명시적 Industry allowlist를 사용한다. 공백·대소문자는 정규화한다.
- 현재 10종목의 정확한 일반 산업명 8개, 명확한 REIT 산업명, 은행 산업명, 거래소 산업명을 등록했다.
- `Financial Data & Stock Exchanges` 입력은 EXCHANGE다. 이는 synthetic 입력 검증이며 CME metadata를 운영에서 조회·추가한 결과가 아니다.
- Sector는 보조 충돌 검사만 한다. Industry와 예상 Sector가 충돌하면 UNKNOWN이다.
- Sector만 있거나 미등록 Industry면 UNKNOWN이다. 일반 제조·기술 Sector라는 이유만으로 GENERAL을 만들지 않는다.
- 모기지 REIT 등 아직 규칙에 등록하지 않은 유형은 UNKNOWN이다. 향후 별도 검토가 필요하다.

## 6. Manual Override

`setManualClassification()` 내부 함수로 지정·해제한다. 공개 HTTP route나 관리자 UI는 추가하지 않았다.
유효 Enum과 1~1000자 이유를 요구하며 자동 분류 행이 먼저 있어야 한다. null 지정으로만 해제한다.
Override는 자동 Profile보다 우선하며 명시적인 UNKNOWN 지정도 가능하다.
회사정보 sync는 Override 값과 이유를 갱신하지 않는다.
`syncProfile()`은 회사정보와 분류 statement를 하나의 DB.batch 트랜잭션으로 실행한다. 분류 쓰기 실패 시 회사정보 갱신도 롤백된다.

## 7. 현재 10종목 결과

2026-09-30 운영 공개 회사 GET을 종목별 1회 읽어 fixture와 대조하고 메모리 DB에서 분류했다.
실제 FMP/SEC 요청·운영 DB 쓰기·재시도는 하지 않았다.

| Ticker | Sector | Industry | Auto Profile | Effective Profile |
|---|---|---|---|---|
| NVDA | Technology | Semiconductors | GENERAL | GENERAL |
| AAPL | Technology | Consumer Electronics | GENERAL | GENERAL |
| MSFT | Technology | Software - Infrastructure | GENERAL | GENERAL |
| JPM | Financial Services | Banks - Diversified | BANK | BANK |
| O | Real Estate | REIT - Retail | REIT | REIT |
| ABBV | Healthcare | Drug Manufacturers - General | GENERAL | GENERAL |
| ABT | Healthcare | Medical - Devices | GENERAL | GENERAL |
| AMZN | Consumer Cyclical | Specialty Retail | GENERAL | GENERAL |
| GOOGL | Communication Services | Internet Content & Information | GENERAL | GENERAL |
| TSLA | Consumer Cyclical | Auto - Manufacturers | GENERAL | GENERAL |

기대값은 ticker가 아니라 독립적인 산업별 테스트 표로 검증하며 ticker를 임의 문자열로 바꿔도 결과가 동일하다.

## 8. EXCHANGE Synthetic Test

`sector=Financial Services`, `industry=Financial Data & Stock Exchanges` → EXCHANGE PASS.
판정 함수는 ticker를 읽지 않는다. CME를 운영 DB에 추가하지 않았다.

## 9. UNKNOWN / Conflict 처리

Sector만 있는 금융·부동산·기술 입력, 미등록/잘못된 Industry 입력, Industry-Sector 충돌을 UNKNOWN으로 처리한다.
review_status는 needs_review, confidence는 low다. 수동 보정이 있으면 보정 결과가 우선한다.

## 10. API 구조

`GET /api/companies/:ticker`에 `analysisProfile`만 additive로 추가했다.

```json
{
  "type": "REIT",
  "autoType": "REIT",
  "overridden": false,
  "confidence": "high",
  "reason": "명시적으로 등록된 Industry 규칙과 일치합니다.",
  "ruleVersion": 1,
  "reviewStatus": "classified",
  "storageStatus": "current"
}
```

기존 필드·financials·배당·일봉·technicalSignal은 유지한다.
GET에서 저장·migration·외부 호출을 하지 않는다.
분류 table 미적용/미저장은 not_stored로 runtime 판정한다. 원본 metadata나 규칙 버전이 바뀌면 stale로 재판정하되 유효 Override를 유지한다.
일반 DB 오류는 fallback으로 숨기지 않는다.
회사 목록 API 형식은 변경하지 않았다.

## 11. UI 영향

변경 없음.
app.js, index.html, style.css, financial-chart.js 및 SEC 재무 metadata 계산 파일은 checkpoint와 내용이 동일함을 테스트했다.
Profile은 UI에서 사용하지 않는다. FFO/AFFO·은행 지표·거래소 사업 지표는 구현하지 않았다.
브라우저 수동 조작 검증은 추가로 수행하지 않았으며 기존 UI 회귀 테스트와 소스 동일성으로 검증했다.

## 12. Numeric Regression

운영 회사 GET에서 읽은 10종목의 500개 재무 행을 메모리 SQLite에 복제했다.
0017 적용, 분류 저장, 실제 syncProfile 경로에 저장 metadata를 mock 응답으로 재생한 뒤 전체 financial_metrics 행을 비교했다.

- 재무 12개 필드의 비교 슬롯: 6,000개(NULL 포함).
- 실제 숫자 값: 3,347개.
- 변경 재무 행: 0개.
- 전후 SHA-256: `cdfec23a4a76a8c3e57a673cac2955b33897cb1d26d36af2d4ce8c75e48d2307`.
- 기존 회사 API 필드 비교: PASS.

이는 운영 저장 응답을 복제한 로컬 전후 검증이다. 운영 D1 전체 테이블을 직접 추출한 검증이나 운영 sync 실행은 아니다.
재검증 명령: `npm run classification:audit`. 이 명령만 공개 GET 10회를 수행하며 npm test에서는 실행하지 않는다.

## 13. Migration 검증

- Fresh: 메모리 SQLite에 0001~0017 순차 적용 PASS.
- Existing: 0001~0016 상태 및 기존 회사·재무 표본을 준비하고 0017만 적용 PASS.
- 기존 회사 값 및 재무 digest 불변 PASS.
- Enum/일관성/Override/FK 제약 PASS.
- 실제 SQLite batch 롤백 PASS.
- 운영 migration 적용 없음. Cloudflare D1 배포 환경에서의 실행 검증은 다음 승인 단계에 남아 있다.

## 14. Test

- 기존 175개: PASS, 기존 테스트 파일 수정 없음.
- 신규 24개: PASS.
- 총 199 PASS / 0 FAIL.
- npm run check: PASS.
- git diff --check: PASS.
- UI·SEC 계산 내용 불변, stale/미적용 fallback, Override 보존·해제, null metadata 입력 및 API 호환 검증 포함.

## 15. 수정 파일

- 신규: worker/src/company-classification.js
- 신규: worker/migrations/0017_company_classification.sql
- 신규: tests/company-classification.test.js
- 신규: tests/fixtures/company-classification-metadata.json
- 신규: scripts/company-classification-audit.mjs
- 신규: docs/company-classification-phase-p1-report.md
- 수정: worker/src/fmp-sync.js (회사정보·분류 동시 저장, 누락 metadata의 NULL 바인딩)
- 수정: worker/src/index.js (단일 회사 GET additive field)
- 수정: package.json (신규 모듈 문법 검사 및 수동 audit 명령)

## 16. Production 변경

production migration / production DB write / Worker deploy / Pages deploy / commit / push: 전부 NO.
기존 checkpoint는 그대로 유지되고 이번 변경은 미커밋 로컬 작업이다.

## 17. 발견 문제

- 누락 회사정보 필드를 undefined로 바인딩하는 기존 경로가 테스트에서 드러나 NULL 바인딩으로 보완했다. 재무 계산 변경은 없다.
- 향후 배포할 때는 0017을 먼저 적용해야 한다. GET은 미적용 fallback이 있지만 회사정보 sync는 분류 table이 필요하다.
- 현재 schema에 SIC/security type이 없으므로 이 우선순위는 아직 구현하지 않았다.
- allowlist 밖의 신규 산업은 안전하게 UNKNOWN이 되므로 검토 후 규칙 추가가 필요하다.
- CIK는 보조 snapshot이며 ticker 변경·복수 share class의 영구 identity 시스템은 구현하지 않았다.
- 운영 분류 backfill과 관리자 HTTP 인증/UI는 이번 범위가 아니다.
- 실제 Secret 값·실제 이메일은 추가하지 않았으며 테스트의 local-test-placeholder는 가짜 값이다.

## 18. 다음 단계 준비

O의 공식 FFO/AFFO 자료 조사와 값 대조를 시작할 준비가 되었다.
분류와 지표 확보 여부는 별개이며 REIT 판정만으로 FFO/AFFO가 확보된 것은 아니다.
다음 단계는 공시 정의·총액/주당 기준·기간·reconciliation을 검증하는 자료 조사부터 시작한다. 데이터 저장·UI 및 운영 배포는 별도 승인 범위다.

## 최종 YES/NO

1. ticker 하드코딩 없이 O REIT: YES.
2. ticker 하드코딩 없이 JPM BANK: YES.
3. exchange Industry 입력 EXCHANGE: YES.
4. 모호한 입력 UNKNOWN: YES.
5. Manual Override 우선: YES.
6. 회사 sync 후 Override 보존: YES.
7. 기존 API 호환: YES.
8. 로컬 재무 숫자 변경 0건: YES.
9. 기존 UI 변화 없음: YES.
10. O FFO/AFFO 공식 자료 검증 시작 가능: YES.
