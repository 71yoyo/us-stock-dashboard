# R11B-1H-FIX — 로컬 배포 설정 검증 보고서

## [R11B-1H-FIX Verdict]

**A. OBSERVABILITY + DEPLOY TOOLCHAIN FIX READY FOR CHECKPOINT**

승인된 Observability 의미를 명시했고, 독립된 임시 환경의 실제 설치로 Wrangler 실행 버전 `4.136.1`을 확인했다. 이번 단계는 로컬 구현·검증만 수행했다. checkpoint 생성 및 다음 단계는 실행하지 않았다.

## [Checkpoint]

시작 및 최종 HEAD: `0ff71e8da69197b0258727b2229a499207ab33d1`.

시작 Git 상태는 clean이었다. 최종 상태는 아래 7개 controlled changes가 미커밋 상태이므로 clean이 아니다.

## [Root Cause]

기존 R11B-1H에서 확인한 운영 상태와 설치 코드 증거를 재사용했다. 해당 단계의 Cloudflare 조회는 반복하지 않았다.

1. App config에 Observability가 없었고 Wrangler `4.136.1`의 기존 module Worker 배포 경로에는 `observability: worker.observability ?? { enabled: false }` 기본값이 있었다. 따라서 설정 생략을 운영 상태 보존으로 간주할 수 없었다.
2. 기존 dependency `^4.69.0`와 tracked lockfile 없음의 조합은 fresh `npm install`에서 검증 버전 `4.136.1`을 고정하지 않았다.

## [Observability Config]

`worker/wrangler.jsonc`에 아래 의미만 추가했다. 미확인 destinations, redact_query_string, issues 등은 추가하지 않았다.

| 항목 | 명시값 |
| --- | --- |
| enabled | true |
| top sampling | 1 |
| logs enabled | true |
| logs sampling | 1 |
| invocation logs | true |
| persist | true |
| traces | false |

실제 field 경로는 각각 `observability.enabled`, `observability.head_sampling_rate`, `observability.logs.enabled`, `observability.logs.head_sampling_rate`, `observability.logs.invocation_logs`, `observability.logs.persist`, `observability.traces.enabled`다.

## [Wrangler Reproducibility]

- before dependency: `^4.69.0`
- tracked lockfile: 없음
- decision: **B. EXACT_VERSION_PIN_REQUIRED**
- candidate version: `4.136.1` exact
- clean install version: CLI 및 설치 package 모두 `4.136.1` exact

기존 working tree의 node_modules를 설치 검증 근거로 사용하지 않았다. 새로운 disposable Temp 환경에 candidate package.json을 복사하고 공식 npm registry에서 실제 `npm install`을 수행한 뒤 실제 `npx wrangler --version`과 설치 package version을 함께 대조했다. fresh 설치 schema도 로컬 검증 schema와 byte exact였다. 임시 환경은 안전한 대상 경로를 확인한 뒤 제거했다.

첫 설치 확인 시 로컬 helper의 error-only logging이 정상 `--version` 출력을 숨겨 receipt 검증이 실패했다. 제품 config는 바꾸지 않고 helper의 버전 확인 logging만 수정한 뒤 새로운 임시 환경에서 설치와 버전 확인을 다시 수행해 통과했다.

exact pin은 **Wrangler 실행 버전**의 재현성을 확보한다. 모든 transitive dependency tree의 동일성까지 보장하는 것은 아니다. 전체 tree를 고정하려면 별도의 lockfile과 일관된 설치 계약이 필요하지만 이번 범위에는 요구되지 않으므로 tracked package-lock.json을 추가하지 않았다. Cloudflare Dashboard build/deploy command도 변경하지 않았다.

## [Dry Run]

- JSONC parse: PASS
- 설치된 공식 Wrangler schema의 candidate 경로 검증: PASS
- Wrangler 자체 config normalization: PASS
- unknown / deprecated / ignored fields: 0 / 0 / 0
- warnings: 0
- dry deploy: PASS
- observability emitted: 승인 의미 exact
- 실제 upload / deploy: 0 / 0

Wrangler `4.136.1`의 실제 `deploy --dry-run`이 생성한 multipart metadata를 로컬에서 해석해 Observability 7개 의미가 유지되는 것을 확인했다. 단순히 config를 다시 출력한 결과를 dry-run 증거로 대체하지 않았다. 원본 multipart는 확인 후 제거하고 sanitized receipt만 ignored evidence에 저장했다.

App runtime bundle SHA-256은 R11B-1H 로컬 bundle과 동일했다:

`0cb2641b44d3c4bc88eb0e759b02497845e4e1d220efc5e8242bbc0b9a239e9c`

## [Preservation]

| 보호 항목 | 결과 |
| --- | --- |
| D1 binding | 기존 R11B-1H 증거 및 승인 config와 exact |
| public vars | 기존 3개 exact |
| Cron | 기존 5개 exact |
| compatibility date / flags | 기존 값 exact |
| name / main / 기타 기존 config | Observability 이외 전체 deep equality PASS |
| routes / workers.dev 관련 config | 변경 없음 |
| raw flags | OFF/unset 유지 |
| App Queue binding | 추가 없음 |
| Consumer / producer / D1 adapter / importer runtime | 수정 0 |
| migration / financial / classification / UI | 수정 0 |

Secret은 값이나 운영 재배포로 검증하지 않았다. 기존 Secret은 일반 deploy에서 삭제되지 않는다는 공식 preservation contract를 근거로 유지했다. 이번 단계에서 Secret 조회·변경 및 실제 배포는 없다. 관련 근거: [Wrangler Worker 명령 문서](https://developers.cloudflare.com/workers/wrangler/commands/workers/).

기존 check의 config 전체 byte equality는 승인된 Observability 추가만 허용하는 구조적 비교로 바꿨다. D1/vars/Cron/compatibility/raw flags 등 나머지 설정은 여전히 exact 보호하며 drift 거부 테스트를 추가했다. runtime과 migration의 기존 byte 보호는 그대로 유지했다.

## [Pages]

- `npm run build:pages`: PASS
- artifact: `.pages-dist`
- files: 10 exact
- unexpected: 0
- frontend source: 변경 0
- generated artifact 및 backups stage: 0
- Pages build configuration 변경: 0

이미 완료된 R11B-1G 설정은 수정하지 않았다.

## [Tests]

- before: 1,254
- new: 20
- final: **1,274 PASS / 0 FAIL / 0 SKIP**
- `npm run check`: PASS
- `npm run build:pages`: PASS
- `git diff --check`: PASS

신규 테스트는 7개 Observability 의미, 공식 schema/type/unknown field, D1/vars/Cron 보호, raw OFF/unset, drift 거부, exact pin, Wrangler 자체 normalization, clean-install receipt 계약, 실제 Pages 10개 artifact를 검증한다. 별도의 실제 clean install 결과도 확보했다.

처음 전체 테스트는 1,273 PASS / 1 FAIL이었다. 기존 telemetry 합성 DB snapshot 비교 출력에서 실패했고, 해당 기존 테스트를 분리 실행해 38 PASS / 0 FAIL을 확인했다. snapshot에서 cached_at이 제거되지 않는 시간 경계 영향은 가능성으로만 판단했다. 기존 테스트·fixture·runtime은 수정하지 않았으며, 다른 무거운 검증을 동시에 실행하지 않은 최종 전체 `npm test`가 1,274 PASS / 0 FAIL / 0 SKIP으로 통과했다. 최초 실패 receipt도 ignored evidence에 보존했다.

## [Changed Files]

정확히 7개다.

1. `worker/wrangler.jsonc` — 승인 Observability 의미 명시
2. `package.json` — Wrangler exact pin 및 로컬 config check 연결
3. `scripts/app-deploy-config-check.mjs` — schema/normalization/preservation/version 검증
4. `tests/app-deploy-config.test.js` — 신규 focused 테스트 20개
5. `scripts/sec-raw-production-check.mjs` — 관련 allowlist 및 좁은 Observability 예외
6. `scripts/sec-raw-historical-plan-check.mjs` — 같은 좁은 config 예외; 기존 migration/runtime 보호 유지
7. `docs/reit-metrics-r11b1h-fix-report.md` — 이 보고서

실제 Secret/API key/token/email/환경파일, CompanyFacts 원문, PDF, cache, SQLite, backup evidence, generated artifact는 controlled changes에 없다. 설치 산출물과 sanitized 실행 receipt는 ignored 위치 또는 제거된 Temp에만 생성했다.

## [Production Changes]

**ALL ZERO**

Cloudflare API 요청·settings PATCH, Pages/App/Consumer deploy, D1 write, migration, Queue publish, Cron/Secret mutation, SEC request, git push 모두 0이다. 허용된 로컬 clean install은 npm registry만 사용했다.

## [Git]

- HEAD: `0ff71e8da69197b0258727b2229a499207ab33d1`
- controlled changes: 위 7개만
- stage: 0
- commit: NO
- push: NO
- clean: NO — 승인된 구현 변경이 미커밋 상태

## [Next Step]

`R11B-1H-FIX-CHECKPOINT` → checkpoint 이후 별도 승인된 `R11B-1H-RECHECK` → 모든 gate PASS 후에만 `R11B-2`.

이번 단계에서는 어느 후속 작업도 자동 실행하지 않았다.

## [마지막 YES/NO]

1. HEAD 0ff71e exact? YES
2. observability explicit? YES
3. enabled=true? YES
4. sampling=1? YES
5. logs enabled=true? YES
6. logs sampling=1? YES
7. invocation_logs=true? YES
8. persist=true? YES
9. traces=false? YES
10. config schema PASS? YES
11. dry deploy PASS? YES
12. D1 unchanged? YES
13. vars unchanged? YES
14. Cron 5 unchanged? YES
15. raw flags OFF/unset? YES
16. Wrangler version deterministic? YES — 실행 버전 기준
17. clean install exact tested version? YES
18. Pages artifact 10 exact? YES
19. Consumer runtime changes 0? YES
20. migration 0? YES
21. Production mutation 0? YES
22. push 0? YES
23. controlled changes only? YES
24. READY FOR CHECKPOINT? YES
