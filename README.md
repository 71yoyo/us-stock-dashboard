# US Stock Pro

미국 주식의 배당 투자와 주가 투자 관점을 한 화면에서 관리하는 개인용 대시보드입니다. 현재는 정적 프런트엔드이며, 다음 단계에서 Node.js API 서버와 SQLite 금융 데이터 캐시를 연결합니다.

## 1. 현재 기능

1-1. 종합 화면에서 우선 확인, 배당 투자 중심, 주가 투자 중심 종목을 구분합니다.

1-2. 종목을 누르면 차트·재무·배당 탭이 있는 상세 모달을 엽니다.

1-3. 주식 목록 관리 화면에서 배당 투자 목록과 주가 투자 목록을 각각 관리합니다.

1-4. 현재 가격·Williams %R·배당 정보는 화면 구조 검증을 위한 예시 데이터입니다. 실제 금융 API 연결 전에는 투자 판단에 사용하면 안 됩니다.

## 2. GitHub에 올리는 범위

GitHub에는 코드, 화면 구조, 데이터베이스 스키마, 환경 변수의 **예시 파일**만 올립니다.

올리지 않는 항목은 다음과 같습니다.

- 실제 API 키가 담긴 `.env`
- SQLite 금융 데이터 캐시와 개인 백업 파일
- 개인 브라우저의 `localStorage` 데이터

이 규칙은 [.gitignore](.gitignore)에 적용되어 있습니다. 실제 키는 `.env.example`을 복사해 만든 `.env`에만 입력합니다.

## 3. 로컬 실행

Node.js 22.5 이상에서는 아래 명령으로 프런트엔드와 SQLite API 서버를 함께 실행합니다. 처음 실행하면 `data/us-stock-pro.sqlite`가 자동 생성됩니다. 이 파일은 GitHub에 올라가지 않습니다.

```powershell
npm start
```

브라우저에서 `http://localhost:3000`을 엽니다. 서버 상태는 `http://localhost:3000/api/health`에서 확인할 수 있습니다.

현재는 `GET /api/companies`, `GET /api/companies/:ticker`, `POST /api/companies`의 캐시 조회·등록 기반만 준비했습니다. 실제 금융 API 호출과 화면 연결은 데이터 공급자를 확정한 다음 추가합니다.

JavaScript 문법은 다음 명령으로 검사합니다.

```powershell
npm run check
```

## 4. GitHub 저장소 연결 순서

1. GitHub에서 비어 있는 private 저장소를 만듭니다.
2. 이 폴더에서 `git init`으로 로컬 저장소를 시작합니다.
3. `.gitignore`가 적용된 상태로 코드만 첫 커밋합니다.
4. GitHub 원격 주소를 연결한 뒤 push합니다.
5. 이후 Node.js + SQLite 서버를 별도 호스팅 환경에 배포하고, GitHub는 코드 변경 이력과 배포 출발점으로 사용합니다.

`.github/workflows/verify.yml`은 GitHub에 push 또는 pull request가 생길 때 `app.js` 문법을 자동 검사합니다.

## 5. 다음 개발 단계

1. API 공급자와 가격·배당·재무 데이터의 갱신 주기를 확정합니다.
2. 가격·배당·재무 API 동기화 서비스를 추가합니다.
3. 예시 데이터를 SQLite 캐시 기반 API 데이터로 단계적으로 교체합니다.
4. 개인 서버 또는 클라우드에 배포하여 필요할 때 실행합니다.
