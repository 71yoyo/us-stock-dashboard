# Phase P9B — REIT 재무 UI 및 Pages 수동 배포

## 범위와 구조

시작 checkpoint는 `9c524367c404338e097dd5a5e2f7975f44f9fd70`이다.
시작 Git clean, 기존 테스트 692 PASS / 0 FAIL, 문법/공백 검사 및 운영 공개 GET 정상 확인 후 구현했다.

`reit-financial-chart.js`는 profile 분기, 읽기 전용 API client, 순수 데이터 준비/option/tooltip,
REIT controller를 관리한다. `FinancialPanel`은 `company.analysisProfile.type === "REIT"`일 때만
별도 REIT shell을 선택하며 종목 이름을 하드코딩하지 않는다. 다른 profile은 기존 `FinancialChart`를 호출한다.

`financial-chart.js`의 변경은 기존 SRI CDN loader 공개뿐이며 GENERAL 계산/option/tooltip은 불변이다.
`app.js`는 기존 재무 모듈 호출을 facade에 연결하는 부분만 바뀌었다. UI 전체 동결을 요구하던 P1 검사 하나는
P9B의 승인 범위에 맞춰 GENERAL shell/계산/SEC 코드 불변 검사로 전환했다. parser expected는 변경하지 않았다.

## 데이터 기준

- 선택 항목: REIT 핵심, FFO, Normalized FFO, AFFO, FFO/주, NFFO/주, AFFO/주.
- 핵심/개별 금액: `basis=total&shareBasis=not_applicable` 공식 common total 저장값.
- 주당: `basis=per_share&shareBasis=diluted` 저장값. basic fallback 없음.
- 연간 최근 10년, 분기 기본 12Q 및 8Q/20Q/전체. YTD와 CAGR는 UI에 노출하지 않는다.
- 동일 scope/basis의 세 series를 병렬 조회하고 modal session 안에서 공유해 NFFO 미공시 기간도 유지한다.
- 실제 저장값을 더하거나 재계산하지 않는다. 복수 정의의 같은 기간은 검토 gap으로 둔다.
- 최신 요약은 기간 합집합의 최신 기간만 사용하며 과거 NFFO로 fallback하지 않는다.
- 정의 경계는 API `definitionBoundaries` 그대로 세로 점선에 연결한다. 공시 전 NFFO는 null gap이다.
- 변화율은 metric/basis/shareBasis/definitionVersion/owner/귀속이 일치하는 전년·전분기만 계산한다.
  정의가 다르면 `— (정의 변경)`, 전기 미확보나 분모 0이면 `—`이다.

## UI와 안전성

shared tooltip에는 금액/희석 주당 값, FY/FQ, 기간 시작/종료, 정의 버전, 검증 상태와 정의 변경 여부를 표시한다.
긴 정의는 줄바꿈하며 tooltip 내부 스크롤이 가능하다. selector는 button/aria-pressed와 가로 스크롤을 유지한다.
차트 접근성 설명은 종목/기간/지표/범위 변경 시 갱신한다.

API 실패, 전체 빈 series, 일부 미공시를 구분한다. 12초 timeout, modal/ticker 변경 시 AbortController 취소,
응답 generation 검사를 사용한다. 실패한 이전 요청이 새 cache를 삭제하지 않도록 controller identity도 확인한다.
CDN은 기존 ECharts 6.0.0 고정/SRI/crossorigin loader를 재사용한다.

## 검증 도구

`npm run p9b:audit`는 공개 운영 GET만 읽어 실제 O의 모든 금액/주당 저장값과 준비값을 비교한다.
분기 FFO/NFFO/AFFO는 40/19/40, 연간은 10/5/10이며 값/정의 경계가 모두 일치했다.
NVDA/AAPL/MSFT/TSLA/JPM의 GENERAL 숫자/option/tooltip을 시작 checkpoint와 직접 대조한다.

`scripts/reit-financial-preview.mjs`는 별도 `127.0.0.1:4179` QA origin에만 테스트 PIN/관심목록을 생성한다.
운영에는 공개 GET만 전달하고 인증/관심목록 동기화는 로컬 mock으로만 처리한다.
실제 사용자 localStorage, 운영 PIN 또는 API Secret을 읽거나 수정하지 않는다.

실제 브라우저에서 O 7개 항목/연간/분기/8Q/12Q/20Q/전체, 정의 변경 tooltip, NVDA 4개 지표,
JPM empty state 및 REIT 미노출, 기존 1-1/1-3, 모달 닫기/전환, PIN 잠금/해제를 확인했다.
1366×900, 768×1024, 390×844에서 가로 page overflow 없음과 모바일 selector 스크롤을 확인했다.
기존 관심목록/포트폴리오/JSON 백업 형식 regression 테스트도 유지한다.

## 배포 정책

운영 Pages project는 `us-stock-dashboard`, production domain은 `us-stock-dashboard-1zf.pages.dev`,
production branch metadata는 `main`이다. GitHub push를 하지 않고 검증된 local checkpoint의 공개 정적 파일만
별도 allowlist 출력 디렉터리에 복사해 Wrangler Pages direct upload로 배포한다.
Worker/Functions/설정/Secret/환경파일/테스트/보고서/원문 cache는 업로드하지 않는다.

Cloudflare 공식 문서는 Git 연동 프로젝트도 Wrangler로 직접 배포할 수 있음을 설명한다.
이번에는 Git 설정/자동 배포를 바꾸지 않고 push 자체를 하지 않아 연결된 Git build나 Worker build를 유발하지 않는다.
실제 Worker version이 `b6e524a9-1a27-4e26-afed-e549fe32df3c`로 유지되는지도 전후 확인한다.

근거: [Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/),
[Wrangler 직접 업로드](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).

이전 정상 Pages deployment `468b03ea-b0e4-4cef-ac47-5f8b6e2a71b6`를 rollback 후보로 보존한다.
심각한 회귀는 먼저 보고하며 자동 rollback, DB Time Travel은 실행하지 않는다.

최종 local commit hash, 테스트 수, Pages deployment ID/시각, 운영 UI smoke 및 전체 26항목 보고서는
Git 제외 `backups/p9b/final-report.md`와 관련 JSON에 기록한다. production DB write, Worker deploy,
migration/backfill/classification write와 GitHub push는 모두 금지한다.
