# R11B-1F — 전용 Pages artifact 로컬 검증 보고서

## [R11B-1F Verdict]

**A. DEDICATED PAGES ARTIFACT READY FOR CHECKPOINT**

로컬 전용 빌드·artifact 검증 완료. stage/commit/push/deploy 및 Cloudflare Pages 설정 변경은 실행하지 않았다. 현재 운영 Pages 설정은 아직 기존 `output: .`이므로 **main push 금지 상태는 유지**된다. checkpoint 및 별도 설정 전환 승인이 먼저 필요하다.

Parent/현재 HEAD: `ac272b39ef7d59f7b4c441e15ccffb1b4e501d67`.

## [Root Cause]

R11B-1에서 repository root를 Pages output으로 사용하면 clean tracked tree 352개가 후보이며, 프런트엔드 10개 밖의 342개가 포함됨을 확인했다. Git ignore는 이미 추적 중인 server/test/docs 파일을 공개 산출물에서 제외하는 안전장치가 아니다.

이번 구현은 source tree를 재귀 복사하지 않고, 검증된 frontend allowlist만 전용 생성 디렉터리로 복사한다. React 전환, UI 변경, API/DB 계약 변경은 없다.

## [Frontend Allowlist]

count: **10**. R11A의 실제 graph 및 운영 10/10 SHA 일치 evidence를 사용했고, 이번 live static GET으로 다시 10/10 exact를 확인했다. 현재 `index.html`의 로컬 CSS/JS 참조 집합과도 exact이다.

| relative path | 역할 | local SHA-256 |
|---|---|---|
| app.js | UI 상태·이벤트·화면 동작 | 28af04887e436a37d8b2253d7b9a87ae310ff615ea41247e2b176192c5c4f2e6 |
| cloudflare-config.js | 공개 API base URL | 8525a3d12c5e0e072ecd6943f9b924983fe5e65eccd92b593e26226f0731c57f |
| financial-chart.js | 일반 재무 차트 | 5b640edaced91ffca3a13b6c3ce01af47c7a03efff899a3a45a514d42895a067 |
| fundamental-progress.css | 저장 진행 상태 스타일 | 55a97d6be1c8e6ae36d347e46818be2fe0750a4415015fc78be91b898bba756f |
| fundamental-progress.js | 저장 진행 상태 UI | 9ea9f2d9b1d4ae50f1adee1e0bf0ae5748377d6e4abae6629aece000295e0fb2 |
| index.html | 메인 HTML·PIN shell | 01f25b0af1e43e45f76675e83ba4729c46182d621c2ca0c31d949315412edb5f |
| reit-financial-chart.js | REIT 재무 차트 | 44a9ce75cd1be80470ab9445b90b4b1803baf71882e50966a736e7598725182a |
| style.css | 공통 반응형 스타일 | 823abb1c23514b63c19a4d7821c0effaed41f6cd8a5f17d1afe6b035d2220d7f |
| tradingview-widget.js | TradingView 위젯 | 2c2029d0fcea1a4c0ba609aca5620a778480275abfd0760837528dc5e2e95c2c |
| williams-signal.js | Williams 신호 프런트 공용 코드 | 4009156dd9b3f09cbd86ddcf01d8069fc3cba08d04d9976a3c583ea402f2bf24 |

표의 hash는 공개 정적 파일 hash이며 credential hash가 아니다. 프런트엔드 10개 원본은 수정하지 않았다.

## [Build Contract]

- command: `npm run build:pages`
- script: `scripts/build-pages.mjs`
- output: `.pages-dist`
- source-of-truth: repository의 allowlist 원본. generated artifact는 Git ignored이며 commit하지 않음
- clean strategy: 모든 source를 먼저 검증하고, `.pages-dist-build-*`에 bytes 그대로 복사한 뒤 목록·내용을 검증한다. 기존 output을 `.pages-dist-backup-*`로 옮기고 검증된 staging을 rename으로 교체한 후 이전 generated artifact만 정리한다
- 교체는 두 번의 rename이므로 단일 filesystem transaction이라고 주장하지 않는다. 첫 rename 후 교체 실패 시 기존 output을 복원하며 명령은 non-zero로 실패한다
- 삭제 대상은 프로젝트 바로 아래의 이름·실제 절대 경로·디렉터리 상태를 확인한 생성 디렉터리에 한정. repo root/source, symlink/junction, 외부 경로는 삭제하지 않음
- missing/non-regular/symlink/path traversal, 추가 파일·추가 빈 디렉터리, 내용 불일치 모두 fail-closed
- 기존 output의 stale 파일도 다음 정상 build에서 제거. 반복 build의 파일 목록·bytes·hash는 동일
- summary는 공개 파일명·크기·SHA만 출력. 환경파일/credential을 읽거나 summary에 포함하지 않음
- `pages:dev`도 `npm run build:pages && wrangler pages dev .pages-dist`로 변경하여 로컬 개발 명령이 repo root를 제공하지 않도록 함. 이번에는 Wrangler dev/deploy를 실행하지 않음

## [Artifact]

| 검사 | 결과 |
|---|---:|
| count | 10 |
| unexpected | 0 |
| server source | 0 |
| SQL | 0 |
| secret path candidate | 0 |
| workflow | 0 |
| worker | 0 |
| tests | 0 |
| docs | 0 |
| package/config/env/cache/PDF/SQLite/raw evidence | 0 |

완성된 파일명이 고정 allowlist와 exact이므로 그 밖의 path/category를 복사할 수 없다. 실제 API key/token/email이 포함된 소스 변경은 없고 기존 공개 프런트엔드 bytes를 유지했다. `cloudflare-config.js`는 기존 공개 endpoint 설정이며 Secret이 아니다.

## [Production Equality]

- assets: **10/10 HTTP 200**
- exact: **10/10 SHA-256 및 bytes exact**
- 비교 대상: `.pages-dist`와 기존 `https://us-stock-dashboard-1zf.pages.dev/` 정적 파일
- `index.html`은 Pages의 canonical `/` 응답과 비교. 최초 `/index.html`의 redirect를 차단한 후 canonical 경로를 사용했고, 이미 성공한 앞선 5개 asset 비교는 재실행하지 않음
- HTTP 정적 요청 총 12회: 정상 비교 10회 + 최초 redirect 요청 1회 + 원인 확인용 app.js GET 1회. credential/OAuth/API Token 없이 GET만 사용
- 원본 프런트엔드 코드 변경·정규화·줄바꿈 변환 없음. Content mismatch를 정상화로 숨기지 않음

## [Local Smoke]

- `.pages-dist`만 document root로 사용한 일회성 로컬 static server
- index/CSS/JS 10개 모두 HTTP 200, bytes exact. unexpected frontend 404 없음
- 선택적 favicon은 204로 처리하며 artifact 파일을 추가하지 않음
- 기존 PIN shell·키패드 표시 정상, 브라우저 console error 0 / warning 0
- PIN 제출/잠금 해제 및 데이터 변경 조작은 수행하지 않음
- worker/scripts/tests/docs/.github/package/env/migration/backups/cache/SQLite/PDF 경로 13개 모두 **404**
- 로컬 harness는 `connect-src 'none'`으로 운영 API 연결을 차단. API proxy 및 서버 쓰기 경로 없음. 이 헤더는 검증 harness에만 적용했고 배포 artifact에는 추가하지 않음
- computer-use:computer-use 스킬로 기존 Edge 탭에서 PIN shell과 console을 확인한 뒤 원래 사용자 탭으로 복귀
- 실제 UI 재설계가 아닌 동일 bytes의 shell/static smoke 범위. 금융 데이터 수집·사용자 저장 흐름은 이번에 운영에서 실행하지 않음

## [Pages Validator]

설치된 **Wrangler 4.136.1**의 Pages `validate` 파일 선택 함수와 bundled minimatch를 네트워크 기능 없는 VM에서 재사용했다. hash/mime 보조 정보만 대체했으며 selection semantics는 그대로 유지했다.

directory: `.pages-dist`; candidate **exact 10**, unexpected **0**, validator **PASS**. repository root가 아닌 전용 output을 검사했다. 관리형 Cloudflare Git build 자체는 아직 실행하지 않았으므로 실제 deployment 검증이라고 주장하지 않는다.

## [Tests]

- before: 기존 **1233 PASS**
- new: focused **21 PASS / 0 FAIL / 0 SKIP**
- final: **1254 PASS / 0 FAIL / 0 SKIP**
- `npm run check`: **PASS**
- `npm run build:pages`: **PASS**
- `git diff --check`: **PASS**

신규 테스트는 exact graph/allowlist/count, missing/non-regular source, server/secret category 제외, extra/missing output, 빈 추가 디렉터리, traversal, symlink/junction, stale 제거, deterministic 반복, source 불변 및 기존 output 보존, content mismatch, local equality helper, 전용 npm 명령을 검증한다. Windows junction 테스트도 SKIP 없이 실행했다.

최초 `npm run check`는 과거 R10B 변경 범위 guard가 `.gitignore`를 거부하여 중단됐다. 사용자 승인 범위의 관련 check allowlist에 이번 Pages 변경 4개만 추가한 후 전체 check가 PASS했다. 기존 runtime 보호·migration 비교·Secret 검사·stage 금지 조건은 제거하지 않았다. 허용 목록만 수정했으며 producer runtime 의미는 바꾸지 않았다.

## [Changed Files]

controlled **6개**:

1. `scripts/build-pages.mjs` — 고정 allowlist 기반 전용 fail-closed 빌드
2. `tests/pages-build.test.js` — focused 21개
3. `package.json` — `build:pages`, `pages:check`, 전용 `pages:dev`, 기존 check 끝에 구문 검사 추가
4. `.gitignore` — output 및 생성 교체 디렉터리 제외
5. `scripts/sec-raw-production-check.mjs` — 기존 검사의 Pages 변경 allowlist 추가만 수행
6. `docs/reit-metrics-r11b1f-report.md` — 이 보고서

ignored evidence: `backups/r11b1f/`; `.pages-dist/`는 generated 10개이며 tracked 후보가 아님. stage는 0.

## [Protected Areas]

frontend source 10개, 전체 worker source/config, migrations 0001~0022, Queue config, D1 adapter, producer runtime, SEC extraction/identity bridge 및 기존 workflow 변경 **0**. 기존 unit regression 및 보호 파일 비교 PASS. Production DB를 읽거나 변경하지 않아 운영 digest를 이번에 재측정했다고 주장하지 않는다.

## [Production Changes]

**ALL ZERO**: Pages/Worker settings 변경, Pages/App/Consumer deploy, D1 read/write, migration/backfill, Queue publish/config, Cron/flag/Secret, GitHub state write, SEC/BQ/FMP/Massive 요청 모두 0. 허용된 운영 static GET만 수행했다.

## [Git]

- HEAD: `ac272b39ef7d59f7b4c441e15ccffb1b4e501d67`
- controlled changes: 6개
- **Git clean 아님** — 승인된 로컬 미커밋 변경만 존재
- stage: 0
- commit: **NO**
- push: **NO**

## [Future Cloudflare Config]

- build command: `npm run build:pages`
- output: `.pages-dist`
- root: 현재 repository root
- production branch: `main`

이는 **다음 Phase의 target contract**이며 현재 Cloudflare 설정을 바꾼 결과가 아니다. 기존 운영 `output: .`은 그대로다.

## [Next Step]

1. `R11B-1F-CHECKPOINT` — 이 controlled 변경을 별도 승인 후 local commit
2. `R11B-1G` — 별도 승인 후 Pages build command/output을 전환하고 readback
3. App config/Observability preservation preflight
4. 모든 gate 통과 및 별도 승인 후에만 `R11B-2` actual fast-forward push

이번 Phase에서는 다음 단계 자동 실행 없음.

## [마지막 YES/NO]

| 번호 | 확인 | 결과 |
|---:|---|---|
| 1 | parent HEAD ac272 exact? | YES |
| 2 | frontend allowlist exact? | YES |
| 3 | expected frontend count 10? | YES |
| 4 | dedicated output implemented? | YES |
| 5 | output stale-free? | YES |
| 6 | output exact allowlist only? | YES |
| 7 | server-side source 0? | YES |
| 8 | SQL 0? | YES |
| 9 | tests/docs 0? | YES |
| 10 | secret candidate 0? | YES |
| 11 | production frontend equality PASS? | YES |
| 12 | local static smoke PASS? | YES |
| 13 | Pages validator exact 10? | YES |
| 14 | existing 1233 tests 유지? | YES |
| 15 | new tests PASS? | YES |
| 16 | npm run check PASS? | YES |
| 17 | worker runtime changes 0? | YES |
| 18 | migration changes 0? | YES |
| 19 | Production mutation 0? | YES |
| 20 | push 0? | YES |
| 21 | controlled changes only? | YES |
| 22 | READY FOR CHECKPOINT? | YES |

Evidence: `backups/r11b1f/allowlist.json`, `artifact.json`, `pages-validator.json`, `production-equality.json`, `local-smoke.json`, `local-requests.json`, `final-verification.json`. 파일 내용이나 credential을 콘솔/보고서에 출력하지 않았으며 공개 asset SHA 및 sanitized 검사 요약만 기록했다.
