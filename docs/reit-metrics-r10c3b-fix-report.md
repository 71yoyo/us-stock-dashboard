# R10C-3B-FIX — 빈 GitHub 저장소 409 호환성

## 판정

**A. EMPTY-REPO 409 FIX READY FOR CHECKPOINT**

로컬 구현과 모든 지정 검증을 통과했다. 실제 remote 검증은 이번 단계의 범위가 아니며 자동 재개하지 않았다.

## 기준 및 원인

- 시작 HEAD: `728cacbc45364378e91d50c884504ce04049adea`, Git clean 확인.
- 기존 helper는 최초 default ref 조회에 200/404만 허용했다. 이전 remote evidence의 빈 저장소 409는 초기 쓰기 전에 `JOURNAL_IO`로 중단됐다.
- 이번 구현은 초기 ref 조회의 예외만 추가한다. 일반 409 및 journal CAS 충돌 의미는 변경하지 않는다.

## HTTP 계약과 안전 조건

| 응답 | 처리 |
| --- | --- |
| 200 | 기존 ref/SHA 사용. 추가 empty inventory 조회 없음. |
| 404 | 기존 missing-ref bootstrap 경로 유지. |
| 409 empty | 아래 독립 조건을 모두 만족하는 경우에만 기존 bootstrap 허용. |
| 409 ambiguous/unavailable | `JOURNAL_IO`, bootstrap 쓰기 0. |
| 기타/손상/네트워크 실패 | fail-closed, 자동 재시도 0. |

409 허용 조건:

1. 기존 metadata/disconnected guard: expected repository의 `full_name` exact, `private=true`, 유효한 default branch, state branch와 구분, disconnected 승인.
2. 최초 default ref GET의 실제 status가 409이며 JSON 구조가 정확한 empty message와 일치. status가 있으면 409여야 하고 상세 errors가 있으면 비어 있어야 한다.
3. fresh branch inventory GET 200, 배열 `[]`.
4. state branch의 Branch API GET 404.
5. state path의 Contents API GET 404.

본문은 JSON Content-Type과 최대 8 KiB로 제한한다. 공통 HTTP 클라이언트의 timeout/redirect/error sanitization/무재시도 정책을 재사용하며 HTTP status를 404 또는 200으로 변환하지 않는다. 공통 HTTP/CAS 모듈은 수정하지 않았다.

## 쓰기 순서

기존 순서 그대로: 최소 `README.md` PUT → resulting default ref SHA 확인 → `producer-state` ref POST → 빈 `state/journal.json` CAS PUT.

README 외 bootstrap 파일/workflow/license/gitignore 추가 없음. README 이후의 ref 409에는 초기 예외를 재사용하지 않는다. CAS 409/422는 메시지와 무관하게 계속 충돌이다.

## 회귀 및 테스트

- 기존 1,200개 + 신규 33개 = 1,233 PASS / 0 FAIL / 0 SKIP.
- focused production/transport 테스트: 106 PASS / 0 FAIL / 0 SKIP.
- strict empty 409 성공, exact 쓰기 순서, 두 번째 실행 overwrite 0.
- unavailable/ambiguous/손상/과대/비JSON/잘못된 구조/status, 401/403, non-empty inventory, 기존 state branch/path, 잘못된 repo/private/disconnected, network ambiguity 차단.
- 200/404 기존 의미, journal CAS 409/422, stale SHA/current update, synthetic create/read/ACCEPTED/cleanup residue 0 유지.
- production journal 및 경로 이탈 cleanup 금지 유지.

## 검증 명령

- `npm test`: PASS, 1,233 / 0 / 0.
- `npm run check`: PASS. 기존 syntax/protection/Secret 검사 포함.
- `npm run r10c3a:check`: PASS (`npm run check` 마지막 단계로 실행), migrations unchanged 22, staged 0, Secret 검사 PASS.
- `npm run r10c3a:audit`: PASS. 106개 focused 테스트, synthetic residue 0, external calls 0.
- `git diff --check`: PASS.
- 새 check/audit 명령은 추가하지 않았다. 기존 focused audit가 신규 테스트를 함께 실행한다.

## 변경 파일

1. `scripts/sec-raw-state-provisioning.mjs`: 초기 ref 전용 strict empty 409 처리.
2. `tests/sec-raw-production-runner.test.js`: fake API 신규 33개 테스트.
3. `scripts/sec-raw-production-check.mjs`: 이 보고서 한 경로만 기존 범위 허용 목록에 추가. 기존 보호 비교/Secret 검사 유지.
4. `docs/reit-metrics-r10c3b-fix-report.md`: 이번 결과 보고서.

## 보호 범위 및 외부 작업

- migration 0001~0022 변경/적용 0. 새 migration 0.
- consumer, Queue transport, D1 adapter, identity bridge, historical importer, financial/classification/UI/public API, Cloudflare config 변경 0.
- GitHub/Cloudflare/SEC 외부 요청 0. Production D1 read/write 0/0. Queue publish 0. Worker/Pages deploy 0. GitHub remote write 0.
- credential 파일 읽기/사용/변경 0. 실제 Secret/token/email/cache/PDF/임시 원문 추가 0.
- stage/commit/push 0. Git 최종 상태는 위 4개 controlled changes이며 clean으로 판정하지 않는다.

## 다음 단계

모든 gate 통과 시 별도 `R10C-3B-FIX checkpoint commit` 단계가 필요하다. 이후 별도 승인된 `R10C-3B-RESUME2`에서만 실제 bootstrap/CAS/cleanup/disconnected evidence를 검증한다. 이번 단계에서 remote resume를 실행하지 않는다.

## 최종 YES/NO

| 번호 | 확인 항목 | 결과 |
| --- | --- | --- |
| 1 | parent HEAD exact | YES |
| 2 | strict empty 409 지원(로컬 fake API 검증) | YES |
| 3 | 모든 409를 empty로 취급하지 않음 | YES |
| 4 | ambiguous 409 fail-closed | YES |
| 5 | 기존 404 동작 유지 | YES |
| 6 | 기존 200 동작 유지 | YES |
| 7 | non-empty + 409 bootstrap 차단 | YES |
| 8 | 최소 bootstrap sequence 유지 | YES |
| 9 | CAS 409/422 의미 불변 | YES |
| 10 | stale conflict 의미 불변 | YES |
| 11 | cleanup guard 불변 | YES |
| 12 | network ambiguity retry 0 | YES |
| 13 | 기존 1,200개 테스트 유지 | YES |
| 14 | 신규 33개 regression PASS | YES |
| 15 | 지정 check/audit 모두 PASS | YES |
| 16 | migration 변경/적용 0 | YES |
| 17 | 외부 network 0 | YES |
| 18 | Production 변경 0 | YES |
| 19 | 실제 credential 사용 0 | YES |
| 20 | Git controlled changes only | YES |
| 21 | commit 0 | YES |
| 22 | push 0 | YES |
| 23 | READY FOR CHECKPOINT | YES |
