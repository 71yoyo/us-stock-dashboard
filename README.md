# US Stock Pro

미국 주식의 배당 투자와 주가 투자 관점을 한 화면에서 관리하는 개인용 대시보드입니다. 배포 구조는 **Cloudflare Pages(화면) + Workers(API·자동 갱신) + D1(금융 데이터 캐시)** 입니다.

## 1. 현재 기능

1-1. 종합 화면에서 우선 확인, 배당 투자 중심, 주가 투자 중심 종목을 구분합니다.

1-2. 종목을 누르면 차트·재무·배당 탭이 있는 상세 모달을 엽니다.

1-3. 주식 목록 관리 화면에서 배당 투자 목록과 주가 투자 목록을 각각 관리합니다.

1-4. 현재 가격·Williams %R·배당 정보는 화면 구조 검증을 위한 예시 데이터입니다. 실제 금융 API 연결 전에는 투자 판단에 사용하면 안 됩니다.

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

Worker의 Cron은 평일에 실행되어 API 갱신 작업을 시작합니다. Cron 표현식은 UTC 기준이며, 미국 휴장일과 서머타임은 실제 금융 API 연결 단계에서 시장 달력으로 판정합니다. 현재 Cron은 연결 상태를 확인하기 위한 기반만 갖추고 있으며 실제 API 호출은 하지 않습니다.

1. 장중 가격: 시장 개장 시간에만 1~5분 단위
2. 배당·재무: 하루 1회 또는 공시 후 갱신
3. 회사 프로필: 최초 조회 후 장기 캐시
4. 차트: 저장된 캔들에 새 데이터만 추가

`.github/workflows/verify.yml`은 GitHub에 push 또는 pull request가 생길 때 프런트엔드와 Worker 문법을 자동 검사합니다.
