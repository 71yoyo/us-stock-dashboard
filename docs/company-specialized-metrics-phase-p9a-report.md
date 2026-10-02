# Phase P9A — Specialized Metrics Read-only HTTP API

## 범위와 계약

`GET /api/companies/:ticker/specialized-metrics`를 기존 Worker router에 추가했다.
UI/Pages, migration, ingestion, scheduler, classification 저장, financial numeric 계산은 변경하지 않았다.
기존 티커 정규화·CORS·`Cache-Control: no-store`를 유지한다.

필수 query는 `metric`, `scope`, `basis`, `shareBasis`다. 전체 dataset 기본 조회는 없다.

- `metric`: `FFO`, `NORMALIZED_FFO`, `AFFO`.
- `scope`: `quarterly`, `annual`, `ytd`.
- `basis`: 저장 schema의 `total`, `per_share`.
- `shareBasis`: 총액은 `not_applicable`(common total) 또는 `diluted`; 주당값은 `basic` 또는 `diluted`.
- `start`, `end`: 선택, 실제 `YYYY-MM-DD` 날짜. `periodEnd` 양끝 포함.

예시: `/api/companies/O/specialized-metrics?metric=AFFO&scope=quarterly&basis=per_share&shareBasis=diluted`.
중복/미등록 parameter, 잘못된 enum·날짜·티커·URL 인코딩은 DB 접근 전에 400이다.
POST는 405, 미등록 회사는 404, 저장/연결 오류는 내부 내용을 숨긴 한국어 502다.
회사가 존재하되 해당 series가 없으면 200, `data: []`, `available: false`, `availability: no_stored_data`, `unit: null`이다.
REIT 여부만으로 숫자를 생성하지 않는다.

## 조회 의미와 응답

기존 `querySpecializedMetrics`의 primary-period disclosure 정책과 SQL binding을 그대로 사용한다.
Annual 환산, YTD 차감, Q4 생성, YoY/CAGR/성장률 계산은 없다.
각 row에 fiscal 기간, canonical 값/단위, definition owner/version, attribution, validation status가 보존된다.
`definitionBoundaries`를 그대로 제공하며 `economicContinuityAssumed: false`다.
기본 응답은 출처의 건수/종류만 포함하고 전체 provenance·원문·raw 값은 제외한다.
기본 query service의 기존 상세 provenance 응답 계약은 변경하지 않았다.

## CPU 보완

첫 preview는 PASS였으나 첫 운영 측정은 p50 5ms / p95 9ms / 최대 13ms였다.
warmup 제외 90개 중 3개가 10ms를 넘어 완료 gate를 통과시키지 않았다.
이 결과는 Git 제외 `backups/p9a/attempt1`에 보존했다.

캐시나 데이터 삭제 없이 다음 비용을 줄였다.

- 회사·저장 분류를 LEFT JOIN으로 함께 읽고 기존 `analysisProfileFor`를 재사용한다. Override/stale 의미는 동일하다.
- 값 SELECT는 서비스가 실제 사용하는 열만 반환한다. 사용하지 않는 `validation_json` 전송을 제외한다.
- HTTP 전용 내부 `sourceSummaryOnly` 옵션은 SQL에서 출처 건수/종류를 집계한다. 상세 출처 경로는 기본값으로 유지한다.
- compact 경로도 손상 metadata를 거부한다.
- 요청당 SELECT 4회에서 3회로 감소했다. SQL 쓰기와 외부 공급원 재호출은 없다.

## 로컬 검증

기존 638개를 유지한 총 692 PASS / 0 FAIL. `npm run check` PASS.
P7.5/P7.6/P7.7 문법 검사 및 기존 specialized 감사 7개 PASS.
감사는 기존 repo 밖 cache/최소 fixture만 사용했고 네트워크 재다운로드는 하지 않았다.

FFO / AFFO / NORMALIZED_FFO의 diluted 주당 기준:

| scope | FFO | AFFO | NORMALIZED_FFO |
| --- | ---: | ---: | ---: |
| quarterly | 40 | 40 | 19 |
| annual | 10 | 10 | 5 |
| ytd | 20 | 20 | 10 |

서비스와 HTTP의 전체 DTO 동등성, 기본 상세 출처 계약, 정의 경계, 날짜 범위, 미공시 diluted total을 합성하지 않는 동작,
GENERAL/BANK/EXCHANGE/UNKNOWN/REIT empty, invalid input, Override/stale, 손상 metadata,
health/company/list API 회귀, SELECT-only와 메모리 DB 변경 0건을 검증했다.

## 격리 preview와 운영 절차

고정 disposable D1에만 연결한 비공개·1시간 만료 preview에서 실제 앱 전체 router를 실행한다.
preview wrapper는 GET specialized route만 허용하고 모든 SQL을 SELECT로 제한한다. Cron/production binding/원문 Secret이 없다.
9개 series마다 warmup 1회와 측정 10회, 총 99회 HTTP 요청을 실행한다.
CPU는 실제 Workers Observability invocation을 요청 ID·Worker·preview/version ID와 대응해 판정한다.
D1 duration이나 client wall time을 CPU로 바꾸지 않는다. 원시 invocation/header/token은 로컬에 저장하지 않는다.
이번에 생성한 preview는 삭제 후 404로 확인한다. disposable D1은 삭제하지 않는다.

토큰은 먼저 `/user/tokens/verify`에서 active를 확인한다. 인증 실패 시 CPU 조회/재시도를 하지 않는다.
토큰 값·길이·hash는 출력하지 않는다. `worker/.dev.vars.p9a`는 Git 제외·미추적을 읽기 전에 확인한다.

운영 배포는 모든 local/preview/CPU/DB/schema gate 통과 후 `--keep-vars` 수동 배포다.
실제 CPU 로그를 위해 Git 제외 배포 설정에서 observability만 활성화한다.
Secret 이름/타입, 기존 vars 값, D1 binding, Cron 표현식/created_on을 배포 전후 대조한다.
tracked `worker/wrangler.jsonc`는 변경하지 않았다. 이후 배포에서도 관측 로그를 유지하려면 설정을 명시해야 한다.
production GET/SELECT smoke와 자연 Cron observation을 수행하며 수동 Cron/queue 실행은 없다.

## 증거와 checkpoint

최종 보완 preview: CPU p50 2ms / p95 3ms / 최대 6ms, D1 duration p50 3.1423ms / p95 7.4131ms / 최대 9.421ms.
운영 보완 version `b6e524a9-1a27-4e26-afed-e549fe32df3c`, deployment `06620dc3-b0a5-4fc4-b5da-6226126c2dea`.
배포 시각은 2026-10-02 09:14:45 KST다.
운영 CPU p50 2ms / p95 3ms / 최대 5ms, 측정 90건, 10ms 초과 0건, invocation 오류 0건이다.
9개 series와 기존 4개 API는 PASS다. 새 version의 자연 daily/price 및 fundamental/dividend Cron 두 실행은 outcome ok / exception 0이다.
기존 재무 numeric/provenance와 classification, specialized digest는 불변이다. 수동 조회·진단 경로의 DB 쓰기는 0건이다.
배당 요약 sentinel의 자연 갱신은 기존 UTC 날짜별 재계산의 시각과 일치하며 새 BQ API 요청은 없었다.
이는 기존 background pipeline의 정상 쓰기이며 P9A 조회의 쓰기 0건과 구분한다.
첫 관측 토큰의 401 후 새 토큰의 verify active/CPU 조회 성공을 확인했다.
마지막 D1 관리자 OAuth 401은 Wrangler 인증 재확인 후 읽기 전용 검증으로 해결했다. Secret 변경은 없다.

최종 CPU/배포 ID/DB 불변 검증/자연 pipeline/Secret 검사/commit hash는 Git 제외
`backups/p9a/final-report.md`와 관련 JSON 증거에 기록한다.
API 구현과 runtime gate가 모두 성공한 경우에만 `Expose specialized metric read API` local checkpoint를 만든다.
origin/main push, Pages/UI 배포, DB write/migration/backfill, Secret/Cron 변경은 하지 않는다.
P9A 전용 토큰 파일은 Git에 포함하지 않으며 작업 후 로컬 삭제와 Cloudflare 토큰 폐기를 권한다.
삭제/폐기는 별도 사용자 지시 없이 실행하지 않는다.
