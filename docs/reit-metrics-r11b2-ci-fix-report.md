# R11B-2-CI-FIX 보고서

## 목적

깨끗한 GitHub Actions 실행 환경에서 의존성을 설치한 뒤 기존 `npm run check`와 `npm test`가 실행되도록 workflow를 최소 수정한다.

## 원인

실패 실행 `37493686047`은 `ed9d6b3d30d243bd791bc1e7d9004467fa632d7e`에서 `npm run check` 중 `ERR_MODULE_NOT_FOUND`와 `esbuild` 누락으로 실패했다. `.github/workflows/verify.yml`에 checkout과 Node 24 설정은 있었지만 dependency installation 단계가 없었다.

## 변경

`.github/workflows/verify.yml`에서 기존 checkout → Node setup 다음, check 앞에 `npm install --no-package-lock` 단계를 추가했다. 기존 check/test 명령과 실행 순서는 유지했다. lockfile이 추적되지 않고 설치 중 생성된 비추적 lockfile은 기존 범위 검사를 실패시키므로 생성도 막는다. `npm ci`는 사용하지 않는다.

`package.json`은 변경하지 않았다. `esbuild`는 devDependency `0.28.1`, Wrangler는 exact pin `4.136.1`로 선언되어 있다.

## 검증 결과

### 의존성 및 로컬 검증

- `npm run check`: PASS
- `npm test`: 1274 PASS / 0 FAIL / 0 SKIP (기존 로컬 작업 트리와 로컬 전용 백업 자료가 있는 상태)
- `git diff --check`: PASS
- `package.json`: `esbuild` `0.28.1`, Wrangler `4.136.1` exact 선언 확인
- 추적 lockfile 없음. `npm ci`를 쓰지 않으며 설치 단계는 `npm install --no-package-lock`로 고정
- workflow의 checkout → Node 24 → dependency install → check → test 순서와 핵심 YAML 구조를 확인했다. 실행 환경에 YAML 전용 parser/actionlint가 없어 공식 parser 기반 YAML 검증은 수행하지 못했다.

### 격리 clean-checkout 검증

추적 파일만 포함한 임시 clone에서 `node_modules`가 없는 것을 확인한 뒤 workflow와 동일한 설치 명령을 실행했다.

- `npm install --no-package-lock`: PASS
- `npm run check`: PASS
- `npm test`: FAIL. 테스트가 Git에 포함되지 않는 로컬 자료 `backups/r4/acquisition.json` 및 R4 CompanyFacts cache에 의존한다. 실제로 R10C2 및 R10C-3A 테스트에서 해당 `acquisition.json` 파일의 `ENOENT`가 발생했다. 로컬 전용 `backups/r9d`와 `backups/r10a` evidence도 테스트 helper에서 참조한다.
- 이 자료는 비공개 SEC 원문/실행 evidence이므로 GitHub CI에 복사하거나 커밋하지 않았다. 실패 테스트를 skip으로 숨기지도 않았다.

따라서 dependency 설치 누락은 고쳤지만, 새 clean runner에서 전체 테스트를 성공시키는 CI 문제는 미해결이다. 현재 변경만으로 성공한 CI라고 판정하지 않는다.

## 판정

**C. CI FIX BLOCKED**

다음 별도 작업에서 백업 자료에 의존하는 테스트를 공개 가능한 최소 fixture로 자립화하거나, 민감한 로컬 audit와 공개 CI 검증 범위를 안전하게 분리해야 한다. 이번 범위에서는 테스트/fixture를 광범위하게 수정하지 않았다.

## 변경 및 외부 영향

수정 파일은 `.github/workflows/verify.yml`, `scripts/sec-raw-production-check.mjs`, 본 보고서까지 3개다. `package.json`은 수정하지 않았다. Production 변경, 실제 GitHub Actions 실행, push, Cloudflare 배포, DB/Queue 쓰기, SEC 요청은 모두 0이다. Commit하지 않았다.
