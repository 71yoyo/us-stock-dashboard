# US Stock Pro

미국 주식의 배당 투자와 주가 투자 관점을 한 화면에서 관리하는 개인용 대시보드입니다. 배포 구조는 **Cloudflare Pages(화면) + Workers(API·자동 갱신) + D1(금융 데이터 캐시)** 입니다.

Williams %R 신호의 현재 규칙, 결정 이력, 앞으로 추가할 책 연구 메모는 [Williams %R 전략 메모](docs/williams-r-strategy.md)에 따로 기록합니다.

## 1. 현재 기능

1-1. 종합 화면에서 우선 확인, 배당 투자 중심, 주가 투자 중심 종목을 구분합니다.

1-2. 종목을 누르면 차트·재무·배당 탭이 있는 상세 모달을 엽니다.

상세 1-1과 메인 2번 차트는 TradingView Advanced Chart 위젯을 사용합니다. 기본 구성은 일봉·거래량·MA20·Williams %R(14)이며, 화면에 보이는 위젯 하나만 생성합니다. 분석용 3개월 일봉은 FMP를 우선 조회하고 실패·빈 응답이면 Massive에서 받아 D1에 유지합니다.

1-3. 주식 목록 관리 화면에서 배당 투자 목록과 주가 투자 목록을 각각 관리합니다.

1-4. 현재 가격·Williams %R은 저장된 시세·일봉을 사용합니다. SEC 연·분기 배당 이력은 10년 성장 통계에 사용하고, 실제 지급액·배당 종류·빈도·공시일·배당락일·지급일은 Massive에서 저장합니다. 근거가 없는 수익률·일정은 미확보로 표시합니다.

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

로컬에서 Massive 수집을 시험할 때는 `worker/.dev.vars`에 `MASSIVE_API_KEY`를 설정합니다. 이 파일은 Git에서 제외되며 Cloudflare 운영 Worker로 자동 전송되지 않습니다. `wrangler secret put`은 새 Worker 버전을 즉시 배포하므로, 홈페이지 업데이트를 요청받기 전에는 실행하지 않습니다.

관심종목 동기화용 PIN도 Worker Secret으로 등록해야 합니다. `APP_PIN`은 현재 화면 잠금에 사용할 4자리 숫자이며, GitHub에는 절대 저장하지 않습니다. PIN은 편의 잠금이므로 금융계좌 비밀번호처럼 중요한 비밀번호를 사용하면 안 됩니다.

```powershell
npx wrangler secret put APP_PIN --config worker/wrangler.jsonc
```

금융 API 공급자를 결정한 후에만 키를 Secret으로 등록합니다. Secret 값은 GitHub와 소스 코드에 저장되지 않습니다.

```powershell
npx wrangler secret put MARKET_DATA_API_KEY --config worker/wrangler.jsonc
npx wrangler secret put MASSIVE_API_KEY --config worker/wrangler.jsonc
npx wrangler secret put MARKET_DATA_PROVIDER --config worker/wrangler.jsonc
npx wrangler deploy --config worker/wrangler.jsonc
```

배포가 끝나면 출력되는 `https://...workers.dev` 주소를 [cloudflare-config.js](cloudflare-config.js)의 `apiBaseUrl`에 입력합니다. 이어서 Pages 주소도 Worker의 `ALLOWED_ORIGIN` Secret으로 등록합니다.

```powershell
npx wrangler secret put ALLOWED_ORIGIN --config worker/wrangler.jsonc
```

`cloudflare-config.js` 변경은 GitHub에 push해야 Pages 화면에도 반영됩니다. Worker Secret은 Cloudflare에만 존재합니다.

## 6. 자동 갱신 방식

회사·재무·SEC 장기 배당 통계 큐는 24시간 5분 간격으로 최대 2종목을 처리합니다. Massive 지급 이벤트와 FMP/Massive 일봉은 별도 자동 큐에서 한 번에 한 종목·항목씩 처리합니다. `5-3`의 버튼은 SEC 큐를 수동으로 진행합니다. 배당 `저장됨`은 SEC 장기 통계 확인과 Massive 이벤트 조회가 모두 끝난 상태를 뜻합니다.

1. 회사 정보는 기존 CIK가 있으면 재사용하고 30일 주기로 확인합니다.
2. 재무는 SEC 제출 이력을 하루 한 번 확인합니다. 신규/정정 10-K·10-Q가 있을 때만 Company Facts를 다시 읽습니다. 원문이 아직 반영되지 않았다면 다음날 재시도합니다.
3. 연간·분기 주당배당금과 성장 이력은 SEC 공시에서 보존합니다. Massive `/stocks/v1/dividends`는 원래 지급액과 분할 조정액, 배당 종류·빈도·선언일·배당락일·지급일을 별도로 저장합니다. 최근 1년 실제 지급액을 저장 현재가로 나눠 수익률을 계산하고, 현재가가 없으면 7일 이내 저장 일봉 종가를 출처와 함께 사용합니다.
4. 3개월 일봉은 FMP를 먼저 조회합니다. 402·빈 응답·네트워크 실패 시 Massive 일봉으로 보완하며, FMP 402 종목은 7일간 같은 실패를 반복하지 않습니다. Massive 무료 한도 5회/분은 D1에서 공유합니다.

`fundamental-store.js`는 첫 실행에서 추가 테이블을 `CREATE TABLE IF NOT EXISTS`로 준비합니다. 회사·재무·배당 원본은 D1에, UI 설정은 기존 localStorage 형식에 저장됩니다. 임대로 중복 실행을 차단합니다. FMP는 회사 정보·시세·우선 일봉, Massive는 배당 이벤트·보조 일봉에 사용합니다.

배포할 때는 Worker 코드보다 먼저 `0008_massive_sources.sql`까지 D1 마이그레이션을 적용해야 합니다. SEC 배당 기간 이력과 이전 FMP 이벤트는 보존합니다. 새 화면과 계산은 Massive 전용 테이블만 읽으며, 수집 실패 시 기존 Massive 저장값을 유지합니다.

SEC로 부족한 PER·PEG·ROIC는 미확보로 표시합니다. SEC 연간·분기 주당배당금은 지급 이벤트가 아니므로 수익률이나 배당락일로 바꿔 표시하지 않습니다. Massive 지급 이벤트 또는 저장 가격이 없으면 수익률도 미확보로 표시합니다. 미래 일정에 선언일이 있으면 확정, 그렇지 않거나 과거 이벤트에서 유추했으면 예상으로 구분합니다. 무료 Massive Basic은 최근 2년 배당 이력만 제공하므로 10년 성장 통계는 SEC 이력에서 계산합니다. SEC 주당배당금 통계는 분할 조정을 별도 검증해야 합니다. SEC 분기 누적 현금흐름은 차감해 개별 분기로 변환하며 EPS는 누적값을 단순 차감하지 않습니다.

`npm run check`와 `npm test`(Node 24)는 문법, 기간 구분, 원문 재사용, 중복 실행, 호출 예산, 시세·차트 미호출을 검증합니다. GitHub에서도 동일 검사를 실행합니다.
