# US Stock Pro

미국 주식의 배당 투자와 주가 투자 관점을 한 화면에서 관리하는 개인용 대시보드입니다. 배포 구조는 **Cloudflare Pages(화면) + Workers(API·자동 갱신) + D1(금융 데이터 캐시)** 입니다.

Williams %R 신호의 현재 규칙, 결정 이력, 앞으로 추가할 책 연구 메모는 [Williams %R 전략 메모](docs/williams-r-strategy.md)에 따로 기록합니다.

## 1. 현재 기능

1-1. 종합 화면에서 우선 확인, 배당 투자 중심, 주가 투자 중심 종목을 구분합니다.

1-2. 종목을 누르면 차트·재무·배당 탭이 있는 상세 모달을 엽니다.

상세 1-1과 메인 2번 차트는 TradingView Advanced Chart 위젯을 사용합니다. 기본 구성은 일봉·거래량·MA20·Williams %R(14)이며, 화면에 보이는 위젯 하나만 생성합니다. 분석용 3개월 일봉은 Massive를 우선 조회하고, 실제 조회 실패·종목 누락 시에만 FMP로 보완해 D1에 유지합니다.

1-3. 주식 목록 관리 화면에서 배당 투자 목록과 주가 투자 목록을 각각 관리합니다.

1-4. 현재가는 저장된 시세를 사용합니다. 시세가 없으면 마지막 저장 일봉 종가와 기준일을 따로 표시하며, 이를 장중 현재가나 포트폴리오 손익 계산값으로 사용하지 않습니다. Williams %R은 저장 일봉에서 계산합니다. 배당금·수익률·일정·성장률은 Alpha Vantage 이력을 사용하고, 상세 분석의 정기 배당 빈도만 저장된 Massive 정기 이벤트를 사용합니다. 해당 원본이 없으면 미확보로 표시합니다.

1-5. 관심종목 목록은 PIN 인증 뒤 Cloudflare D1과 동기화합니다. 처음 동기화할 때만 현재 브라우저 목록을 D1에 옮기며, 이후에는 D1 목록이 모든 브라우저의 기준이 됩니다.

## 2. GitHub에 올리는 범위

GitHub에는 코드, 화면 구조, D1 마이그레이션, 환경 변수의 **예시 파일**만 올립니다.

올리지 않는 항목은 다음과 같습니다.

- 실제 API 키가 담긴 `.env`
- Cloudflare Secret에 등록한 금융 API 키
- 로컬 D1 에뮬레이터 데이터와 개인 백업 파일
- 개인 브라우저의 `localStorage` 데이터

이 규칙은 [.gitignore](.gitignore)에 적용되어 있습니다. 실제 키는 `.env.example`을 복사해 만든 `.env`에만 입력합니다.

## 3. 폴더 구조

```text
index.html / style.css / app.js      Pages가 배포할 정적 화면
cloudflare-config.js                화면이 호출할 Worker API 주소
worker/src/index.js                 Workers API와 Cron 자동 갱신 진입점
worker/migrations/                 D1 데이터베이스 스키마 이력
worker/wrangler.jsonc              Worker 이름·D1 연결·Cron 설정
```

Worker는 공급원 설정이 없거나 수집에 실패하면 임의 금융 데이터를 생성하지 않고, 저장된 값과 미확보 상태를 분리해 표시합니다.

## 4. 로컬 확인

Node.js를 설치한 뒤 다음 명령으로 Wrangler를 설치하고 문법을 확인합니다.

```powershell
npm install
npm run check
```

Pages 화면과 Worker를 로컬에서 각각 확인할 수 있습니다.

```powershell
npm run pages:dev
npm run worker:dev
```

Worker의 D1 데이터베이스 ID를 만든 뒤에는 아래 명령으로 로컬 스키마도 적용할 수 있습니다.

```powershell
npm run d1:migrate:local
```

## 5. Cloudflare 가입·연동·첫 배포

### 5-1. Cloudflare와 GitHub 연결

1. [Cloudflare 가입 페이지](https://dash.cloudflare.com/sign-up)에서 계정을 만듭니다.
2. Cloudflare 대시보드에서 **Workers & Pages**를 엽니다.
3. **Create application → Pages → Connect to Git**을 선택합니다.
4. GitHub 로그인과 Cloudflare GitHub App 권한 요청을 승인합니다. 권한은 `71yoyo/us-stock-dashboard` 저장소만 선택하는 방식을 권장합니다.
5. 저장소를 선택하고 Production branch는 `main`으로 지정합니다.
6. Framework preset은 `None`, Build command는 비워 두고 Build output directory는 `.`으로 입력합니다.
7. Save and Deploy를 선택합니다. 이후 `main`에 push할 때마다 Pages가 자동 배포됩니다.

### 5-2. D1 생성과 Worker 연결

1. Cloudflare 대시보드의 **Workers & Pages → D1 SQL Database → Create**를 선택합니다.
2. 데이터베이스 이름을 `us-stock-pro`로 입력하고 생성합니다.
3. 생성 화면에서 Database ID를 복사합니다.
4. [worker/wrangler.jsonc](worker/wrangler.jsonc)의 `database_id` 자리표시자를 복사한 ID로 한 번만 교체합니다.
5. 터미널에서 Cloudflare에 로그인하고, 운영 D1 스키마를 적용합니다.

```powershell
npx wrangler login
npx wrangler d1 migrations apply us-stock-pro --remote --config worker/wrangler.jsonc
```

### 5-3. Worker 배포와 Secret 등록

로컬에서 시험할 때는 `worker/.dev.vars`에 `MASSIVE_API_KEY`(일봉)와 `ALPHA_VANTAGE_API_KEY`(배당)를 설정합니다. 이 파일은 Git에서 제외되며 Cloudflare 운영 Worker로 자동 전송되지 않습니다. `wrangler secret put`은 새 Worker 버전을 즉시 배포하므로, 홈페이지 업데이트를 요청받기 전에는 실행하지 않습니다.

관심종목 동기화용 PIN도 Worker Secret으로 등록해야 합니다. `APP_PIN`은 현재 화면 잠금에 사용할 4자리 숫자이며, GitHub에는 절대 저장하지 않습니다. PIN은 편의 잠금이므로 금융계좌 비밀번호처럼 중요한 비밀번호를 사용하면 안 됩니다.

```powershell
npx wrangler secret put APP_PIN --config worker/wrangler.jsonc
```

금융 API 공급자를 결정한 후에만 키를 Secret으로 등록합니다. Secret 값은 GitHub와 소스 코드에 저장되지 않습니다.

```powershell
npx wrangler secret put MARKET_DATA_API_KEY --config worker/wrangler.jsonc
npx wrangler secret put MASSIVE_API_KEY --config worker/wrangler.jsonc
npx wrangler secret put ALPHA_VANTAGE_API_KEY --config worker/wrangler.jsonc
npx wrangler secret put MARKET_DATA_PROVIDER --config worker/wrangler.jsonc
npx wrangler deploy --config worker/wrangler.jsonc
```

배포가 끝나면 출력되는 `https://...workers.dev` 주소를 [cloudflare-config.js](cloudflare-config.js)의 `apiBaseUrl`에 입력합니다. 이어서 Pages 주소도 Worker의 `ALLOWED_ORIGIN` Secret으로 등록합니다.

```powershell
npx wrangler secret put ALLOWED_ORIGIN --config worker/wrangler.jsonc
```

`cloudflare-config.js` 변경은 GitHub에 push해야 Pages 화면에도 반영됩니다. Worker Secret은 Cloudflare에만 존재합니다.

## 6. 자동 갱신 방식

회사·SEC 재무·Alpha Vantage 배당 큐는 5분 간격으로 최대 2종목을 처리합니다. Massive 배당 자동 수집은 보류하지만 저장된 정기 배당 빈도는 상세 분석에서 읽습니다. 미국 동부 정규장 종료 30분 뒤부터 Massive 전체 시장 일봉을 날짜당 한 번 성공할 때까지 확인해 적재를 마친 관심종목만 갱신하고, 묶음 응답에 빠진 종목은 개별 큐에서 보완합니다. `5-3`에서는 실제 최신 일봉 거래일과 저장 확인 시각을 따로 보여주며, 새 일봉이 저장되면 열린 종합 화면도 다시 읽습니다. `5-3`의 배당 `저장됨`은 해당 종목의 Alpha Vantage 배당과 주식분할 응답이 모두 저장됐다는 뜻이며 Massive 빈도 확보 여부와는 별개입니다.

1. 회사 정보는 기존 CIK가 있으면 재사용하고 30일 주기로 확인합니다.
2. 재무는 SEC 제출 이력을 하루 한 번 확인합니다. 신규/정정 10-K·10-Q가 있을 때만 Company Facts를 다시 읽습니다. 원문이 아직 반영되지 않았다면 다음날 재시도합니다.
3. Alpha Vantage `DIVIDENDS`와 `SPLITS`를 종목당 각 1회 호출해 원본과 분할 조정액을 저장합니다. 1·5·10년 성장률은 완료된 역년의 배당락일 기준 연간 합계로 계산하며, 비교 연도의 1월부터 이력이 없으면 `미확보`로 둡니다. 최근 1년 실제 지급액은 지급일 기준으로 합산하고 저장 가격으로 나눕니다. 배당 종류는 Alpha Vantage 응답에 없어 `미확보`, 상세 분석의 정기 배당 빈도는 Massive 저장값이 없으면 `미확보`로 표시합니다. 무료 API는 하루 25회이므로 신규 적재는 약 12종목/일 이하이며 성공 종목은 14일 간격으로 갱신합니다.
4. 신규 종목은 Massive 3개월 일봉을 먼저 채웁니다. Massive 응답이 없거나 오류면 FMP를 보조로 사용하되, Massive의 분당 호출 예산이 찼을 때에는 다음 주기를 기다립니다. FMP 402 종목은 한 달간 같은 보조 요청을 반복하지 않습니다. 기존 FMP 일봉은 Massive 이력의 길이·최신 날짜를 검증한 뒤 활성 데이터에서 교체하고 복구용 테이블에 남깁니다. FMP 보조 데이터는 이미 저장된 Massive 날짜를 덮지 않습니다. Massive 무료 한도 5회/분은 D1에서 공유합니다. 장 마감 후 묶음 API는 한 거래일에 한 번 성공하면 다시 호출하지 않습니다.

`fundamental-store.js`는 첫 실행에서 추가 테이블을 `CREATE TABLE IF NOT EXISTS`로 준비합니다. 회사·재무·배당 원본은 D1에, UI 설정은 기존 localStorage 형식에 저장됩니다. 임대로 중복 실행을 차단합니다. FMP는 기존 회사 정보·시세와 일봉 보조 경로에, Massive는 우선 일봉에 사용합니다. 화면의 현재가 표시 방식은 변경하지 않았습니다.

배포 시에는 새 Worker 코드와 화면을 함께 반영하고 `0013_clear_legacy_sec_dividend_jobs.sql`까지 D1 마이그레이션을 적용해야 합니다. `0012`는 SEC 배당 전용 테이블을 삭제하고, `0013`은 오래된 SEC 배당 작업 오류·설명을 정리하므로 이전 Worker와 혼용하지 않습니다. SEC 재무 자료는 유지합니다. Massive 배당 원본은 보존하며, 상세 분석의 정기 배당 빈도에만 가장 최근 정기 지급 이벤트의 저장된 `frequency`를 사용합니다. 자동 Massive 배당 수집은 보류 중이므로 저장 이력이 없는 신규 종목은 이 항목을 `미확보`로 표시합니다. 배당금·수익률·배당락일·성장률은 Alpha Vantage 기준입니다. 5-3 배당 `저장됨`은 Alpha 배당·분할 수집이 완료되고 저장 이벤트 건수가 동기화 기록과 일치할 때만 표시합니다. 5-3의 3개월 일봉 완료 집계는 Massive 적재가 끝난 종목만 세고, 남은 FMP 종목은 전환 대기로 표시합니다.

SEC로 부족한 PER·PEG·ROIC는 미확보로 표시합니다. Alpha Vantage 배당 이벤트 또는 저장 가격이 없으면 수익률도 미확보로 표시합니다. 미래 일정에 선언일이 있으면 확정, 그렇지 않거나 과거 이벤트에서 유추했으면 추정으로 구분합니다. SEC 분기 누적 현금흐름은 차감해 개별 분기로 변환하며 EPS는 누적값을 단순 차감하지 않습니다.

`npm run check`와 `npm test`(Node 24)는 문법, 기간 구분, 원문 재사용, 중복 실행, 호출 예산, 시세·차트 미호출을 검증합니다. GitHub에서도 동일 검사를 실행합니다.
