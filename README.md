# US Stock Pro

미국 주식의 배당 투자와 주가 투자 관점을 한 화면에서 관리하는 개인용 대시보드입니다. 배포 구조는 **Cloudflare Pages(화면) + Workers(API·자동 갱신) + D1(금융 데이터 캐시)** 입니다.

## 1. 현재 기능

1-1. 종합 화면에서 우선 확인, 배당 투자 중심, 주가 투자 중심 종목을 구분합니다.

1-2. 종목을 누르면 차트·재무·배당 탭이 있는 상세 모달을 엽니다.

상세 1-1과 메인 2번 차트는 TradingView Advanced Chart 위젯을 사용합니다. 기본 구성은 일봉·거래량·MA20·Williams %R(14)이며, 화면에 보이는 위젯 하나만 생성합니다. FMP 3개월 일봉은 위젯과 별개로 D1에 유지하여 목록의 Williams %R, 최신 OHLC, 분석 및 장애 시 대체 데이터로 사용합니다.

1-3. 주식 목록 관리 화면에서 배당 투자 목록과 주가 투자 목록을 각각 관리합니다.

1-4. 현재 가격·Williams %R·배당 정보는 화면 구조 검증을 위한 예시 데이터입니다. 실제 금융 API 연결 전에는 투자 판단에 사용하면 안 됩니다.

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

현재 가격·Williams %R·배당 정보는 화면 구조 검증용 예시입니다. Worker는 실제 데이터 공급자와 API Secret을 등록하기 전에는 임의 금융 데이터를 생성하지 않고, 동기화 보류 이력만 남깁니다.

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

관심종목 동기화용 PIN도 Worker Secret으로 등록해야 합니다. `APP_PIN`은 현재 화면 잠금에 사용할 4자리 숫자이며, GitHub에는 절대 저장하지 않습니다. PIN은 편의 잠금이므로 금융계좌 비밀번호처럼 중요한 비밀번호를 사용하면 안 됩니다.

```powershell
npx wrangler secret put APP_PIN --config worker/wrangler.jsonc
```

금융 API 공급자를 결정한 후에만 키를 Secret으로 등록합니다. Secret 값은 GitHub와 소스 코드에 저장되지 않습니다.

```powershell
npx wrangler secret put MARKET_DATA_API_KEY --config worker/wrangler.jsonc
npx wrangler secret put MARKET_DATA_PROVIDER --config worker/wrangler.jsonc
npx wrangler deploy --config worker/wrangler.jsonc
```

배포가 끝나면 출력되는 `https://...workers.dev` 주소를 [cloudflare-config.js](cloudflare-config.js)의 `apiBaseUrl`에 입력합니다. 이어서 Pages 주소도 Worker의 `ALLOWED_ORIGIN` Secret으로 등록합니다.

```powershell
npx wrangler secret put ALLOWED_ORIGIN --config worker/wrangler.jsonc
```

`cloudflare-config.js` 변경은 GitHub에 push해야 Pages 화면에도 반영됩니다. Worker Secret은 Cloudflare에만 존재합니다.

## 6. 자동 갱신 방식

회사·재무·배당 전용 큐는 24시간 5분 간격으로 최대 2종목을 처리합니다. `5-3. 회사·재무·배당 데이터 수집`의 버튼은 한 묶음의 응답이 끝나면 다음 묶음을 바로 실행합니다. 실행시간이 길면 나머지는 다음 요청/Cron으로 넘깁니다. 진행률의 '수집 확인'과 '일부 저장'은 전체 지표/10년 이력 완성을 뜻하지 않습니다.

1. 회사 정보는 기존 CIK가 있으면 재사용하고 30일 주기로 확인합니다.
2. 재무는 SEC 제출 이력을 하루 한 번 확인합니다. 신규/정정 10-K·10-Q가 있을 때만 Company Facts를 다시 읽습니다. 원문이 아직 반영되지 않았다면 다음날 재시도합니다.
3. 배당은 SEC 주당배당금의 연간·분기 이력과 FMP 이벤트를 저장합니다. 같은 묶음의 재무·배당은 SEC 원문을 재사용합니다. 빈 응답을 무배당으로 단정하지 않습니다.
4. 시세·3개월 차트의 수집 경로와 기존 Cron 시간은 이번 개편에 포함하지 않았습니다. 전용 큐/수동 수집은 시세·일봉 API를 호출하지 않습니다.

`fundamental-store.js`는 첫 실행에서 추가 테이블을 `CREATE TABLE IF NOT EXISTS`로 준비합니다. 회사·재무·배당 원본은 D1에, UI 설정은 기존 localStorage 형식에 저장됩니다. 임대로 중복 실행을 차단하며 FMP 부가 데이터는 하루 150회 예산을 원자적으로 관리합니다(기존 시세 수집 호출은 별도). 402는 해당 종목/API를 30일 보류하고 SEC를 사용하며, 429는 부가 API를 24시간 보류합니다.

SEC로 부족한 PER·PEG·ROIC와 미래 배당 일정은 미확보로 표시합니다. 10년 CAGR은 10년 간격의 양 끝 값이 있을 때만 계산하고, 배당 성장 연수는 확보한 연간 이력 내 엄격한 증가/연속 연도로 제한합니다. SEC 분기 누적 현금흐름은 차감해 개별 분기로 변환하며 EPS는 누적값을 단순 차감하지 않습니다.

`npm run check`와 `npm test`(Node 24)는 문법, 기간 구분, 원문 재사용, 중복 실행, 호출 예산, 시세·차트 미호출을 검증합니다. GitHub에서도 동일 검사를 실행합니다.
