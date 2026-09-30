# SEC 재무 Phase 1.6A 운영 반영 사전 점검 · 중단 보고서

작성일: 2026-09-30 · 시간대 Asia/Seoul.
결론: [PRODUCTION BLOCKER]. Cloudflare 원격 검증 세션의 사전 확인이 500을 반환하여 중단했다.
기존 공개 운영 API가 500을 반환했다는 뜻은 아니다. 운영 migration, 배포, 데이터 재처리는 실행하지 않았다.

## [1. 시작 Git 상태]

branch: main. 최근 commit: b887854, Update deployed Worker build version.
Phase 1/1.5 변경 목록과 정확히 일치했고 예상 외 수정은 없었다. reset·삭제·커밋·push는 하지 않았다.

시작 수정: package.json, worker/src/fmp-sync.js, worker/src/fundamental-sync.js, worker/src/index.js.
시작 신규: docs/sec-financial-phase1-report.md, docs/sec-financial-phase1-5-report.md, scripts/sec-financial-audit.mjs,
tests/sec-financial-metadata.test.js, tests/sec-financial-audit.test.js,
worker/migrations/0016_sec_financial_metadata.sql, worker/src/sec-financial-metadata.js.
git diff --stat은 추적 파일 4개, 추가 32줄·삭제 10줄이었다. 신규 파일은 이 통계에 포함되지 않는다.

## [2. Pre-deploy Test]

시작 상태 그대로 npm test: 100 PASS / 0 FAIL.
npm run check: PASS. git diff --check: PASS.
이후 소규모 실행 안전장치 테스트 4개를 추가해 104 PASS / 0 FAIL을 확인했다. 기존 100개 테스트는 수정하지 않았다.
Node 문법 검사와 운영 deploy --dry-run도 통과했다. 단, 이 통과가 Cloudflare 런타임 호환성 검증을 대신하지는 않았다.

## [3. Production 환경]

Worker: us-stock-dashboard-api.
D1 binding: DB.
D1 name: us-stock-pro.
D1 id: 698ab9b8-4573-40c7-b119-d7b1d681abc8.
운영 설정: worker/wrangler.jsonc.

| 운영 Secret | 존재 여부 |
| --- | --- |
| SEC_USER_AGENT | configured |
| BUSINESS_QUANT_API_KEY | configured |
| MARKET_DATA_API_KEY | configured |
| FMP_API_KEY | missing |

실제 이메일·키·토큰 값은 출력하지 않았다. Secret을 추가·교체하지 않았다.
기본 Node 실행의 인증 갱신은 실패했지만 --use-system-ca로 시스템 인증서 저장소를 사용하자 기존 OAuth 인증이 정상 동작했다. TLS 검증을 해제하지 않았다.

예정 명령(실행하지 않음):

```powershell
node --use-system-ca node_modules/wrangler/bin/wrangler.js d1 migrations apply us-stock-pro --remote --config worker/wrangler.jsonc
node --use-system-ca node_modules/wrangler/bin/wrangler.js deploy --config worker/wrangler.jsonc --keep-vars
```

## [4. Production SEC 접근]

사전 확인에 공식 wrangler dev --remote 검증 세션을 사용했다. 운영 Worker와 같은 이름의 SEC_USER_AGENT Secret을 inherit 방식으로 상속하고, 동일한 운영 DB를 바인딩했지만 사전 확인은 DB에 쓰지 않는다.
원격 preview는 Cloudflare에서 실행되고 로컬 127.0.0.1:8796을 통해 인증된 개발 채널로 접근한다. 공개 운영 Worker를 배포하거나 새 공개 진단 endpoint를 추가하지 않았다.

실제 요청 GET /sec-preflight는 HTTP 500.
오류: TypeError: Invalid redirect value, must be one of "follow" or "manual".
검증 도구가 Node fetch에서 허용되는 redirect:error를 사용했지만 Cloudflare Workers는 이를 지원하지 않았다.

SEC_USER_AGENT의 실제 연락 이메일 포함 검사까지는 통과했다. SEC HTTP 요청은 fetch 옵션 검사에서 실패해 송신되지 않았다.
따라서 SEC HTTP status는 미확인이다. SEC 403이나 운영 egress 차단으로 판정하지 않는다.
한 번만 사전 확인했고 재시도하지 않았다. 기존 공개 API의 5xx가 아니라 검증 preview의 5xx다.

## [5. Recovery 준비]

공식 D1 Time Travel 조회 성공. 실제 운영 DB의 변경 전 bookmark:

```text
00000947-00000000-000050f6-5542f57cff9b03a517bca0f0f3750193
```

공식 복구 경로:

```powershell
node --use-system-ca node_modules/wrangler/bin/wrangler.js d1 time-travel restore us-stock-pro --bookmark=00000947-00000000-000050f6-5542f57cff9b03a517bca0f0f3750193 --config worker/wrangler.jsonc
```

이 명령은 기록만 했고 실행하지 않았다. 복구는 DB 전체를 덮어쓰므로 별도 승인과 운영 중 발생한 다른 정상 write의 손실 검토가 필요하다.
무료/유료 플랜에 따라 보존 기간이 다르므로 bookmark는 영구 백업이 아니다. 전체 DB export는 하지 않았다.
[Cloudflare 공식 Time Travel 안내](https://developers.cloudflare.com/d1/reference/time-travel/)

## [6. Migration 0016 검토]

additive-only: YES. destructive operation: NO.
financial_metrics에 fiscal_year, fiscal_period, period_start를 ADD COLUMN하고 출처 테이블 및 인덱스를 생성한다.
기존 숫자 UPDATE/DELETE, DROP/RENAME, PK 변경은 없다.
출처 테이블의 ON DELETE CASCADE는 추후 부모 삭제 시 출처를 정리하는 제약이며 마이그레이션 실행 자체의 기존 데이터 삭제가 아니다.
0001~0016 내용은 이번에 수정하지 않았고 0017을 만들지 않았다.

## [7. Migration 적용]

미실행 · 사전 확인 오류로 중단.
운영 적용 이력은 0001~0015이며 미적용 목록에는 0016만 있었다.
운영 financial_metrics schema의 열은 아래와 같았다.

```text
ticker, period_type, fiscal_period_end, reported_date, currency, revenue, operating_income, net_income, eps, peg_ratio, pe_ratio, ps_ratio, free_cash_flow, roe, roic, gross_margin, operating_margin, source, source_updated_at, cached_at
```

이번 작업에서 적용 후 schema는 없다. 0016을 운영에 적용했다고 주장하지 않는다.
migrations list에 지원되지 않는 --json을 처음 넣어 CLI 옵션 오류가 있었고, 올바른 읽기 전용 명령으로 미적용 목록을 확인했다. DB migration 실패가 아니라 CLI 입력 오류였다.

## [8. Migration 후 Numeric 보존]

Migration이 실행되지 않아 전후 검증은 미실행이다.
변경 전 운영 baseline을 읽기 전용으로 확보했다.
financial_metrics 총 500행, sec_filing_checks 9행. 모든 사전 SQL 결과의 rows_written은 0이었다.

| 종목 | 구분 | 저장 행 | 최신 종료일 |
| --- | --- | --- | --- |
| AAPL | annual | 10 | 2025-09-27 |
| AAPL | quarterly | 40 | 2026-06-27 |
| JPM | annual | 10 | 2025-12-31 |
| JPM | quarterly | 40 | 2026-06-30 |
| MSFT | annual | 10 | 2026-06-30 |
| MSFT | quarterly | 40 | 2026-06-30 |
| NVDA | annual | 10 | 2026-01-25 |
| NVDA | quarterly | 40 | 2026-07-26 |
| O | annual | 10 | 2025-12-31 |
| O | quarterly | 40 | 2026-06-30 |

NVDA 최근 Annual 2개·Quarterly 4개 × 8개 지표 baseline:

| 기간 | 지표 | Before | After | Difference | 상태 |
| --- | --- | --- | --- | --- | --- |
| annual 2026-01-25 | revenue | 215938000000 | 미실행 | — | 재처리 전 중단 |
| annual 2026-01-25 | operating_income | 130387000000 | 미실행 | — | 재처리 전 중단 |
| annual 2026-01-25 | net_income | 120067000000 | 미실행 | — | 재처리 전 중단 |
| annual 2026-01-25 | eps | 4.9 | 미실행 | — | 재처리 전 중단 |
| annual 2026-01-25 | free_cash_flow | 96676000000 | 미실행 | — | 재처리 전 중단 |
| annual 2026-01-25 | roe | 76.33333969089534 | 미실행 | — | 재처리 전 중단 |
| annual 2026-01-25 | gross_margin | 71.06808435754708 | 미실행 | — | 재처리 전 중단 |
| annual 2026-01-25 | operating_margin | 60.38168363141272 | 미실행 | — | 재처리 전 중단 |
| annual 2025-01-26 | revenue | 130497000000 | 미실행 | — | 재처리 전 중단 |
| annual 2025-01-26 | operating_income | 81453000000 | 미실행 | — | 재처리 전 중단 |
| annual 2025-01-26 | net_income | 72880000000 | 미실행 | — | 재처리 전 중단 |
| annual 2025-01-26 | eps | 2.94 | 미실행 | — | 재처리 전 중단 |
| annual 2025-01-26 | free_cash_flow | 60853000000 | 미실행 | — | 재처리 전 중단 |
| annual 2025-01-26 | roe | 91.87288060811576 | 미실행 | — | 재처리 전 중단 |
| annual 2025-01-26 | gross_margin | 74.98869705816992 | 미실행 | — | 재처리 전 중단 |
| annual 2025-01-26 | operating_margin | 62.417526839697466 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-07-26 | revenue | 96221000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-07-26 | operating_income | 63734000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-07-26 | net_income | 59688000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-07-26 | eps | 2.46 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-07-26 | free_cash_flow | 21400000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-07-26 | roe | 26.06645005764595 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-07-26 | gross_margin | 74.97531723844068 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-07-26 | operating_margin | 66.23710000935347 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-04-26 | revenue | 81615000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-04-26 | operating_income | 53536000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-04-26 | net_income | 58321000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-04-26 | eps | 2.39 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-04-26 | free_cash_flow | 48587000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-04-26 | roe | 29.835681471704678 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-04-26 | gross_margin | 74.9335293757275 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-04-26 | operating_margin | 65.59578508852539 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-01-25 | revenue | 68127000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-01-25 | operating_income | 44299000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-01-25 | net_income | 42960000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-01-25 | eps | NULL | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-01-25 | free_cash_flow | 34904000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-01-25 | roe | 27.312086361122233 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-01-25 | gross_margin | 74.99669734466511 | 미실행 | — | 재처리 전 중단 |
| quarterly 2026-01-25 | operating_margin | 65.02414608011507 | 미실행 | — | 재처리 전 중단 |
| quarterly 2025-10-26 | revenue | 57006000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2025-10-26 | operating_income | 36010000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2025-10-26 | net_income | 31910000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2025-10-26 | eps | 1.3 | 미실행 | — | 재처리 전 중단 |
| quarterly 2025-10-26 | free_cash_flow | 22115000000 | 미실행 | — | 재처리 전 중단 |
| quarterly 2025-10-26 | roe | 26.83835588786933 | 미실행 | — | 재처리 전 중단 |
| quarterly 2025-10-26 | gross_margin | 73.41157071185489 | 미실행 | — | 재처리 전 중단 |
| quarterly 2025-10-26 | operating_margin | 63.16878925025436 | 미실행 | — | 재처리 전 중단 |

## [9. Worker 배포]

미실행 · 사전 확인 오류로 중단.
새 production deployment version은 없다. 운영 Worker는 기존 배포 상태다.
로컬 dry-run만 성공했다. 검증 remote preview 업로드를 production 배포 성공으로 계산하지 않는다.

## [10. 배포 직후 API Smoke Test]

미실행. 새 Worker 배포가 없어 배포 후 API 검증 단계에 도달하지 않았다.
운영 API에서 5xx가 발생했다고 주장하지 않는다.

## [11. NVDA 재처리]

미실행. SEC fetch status도 미확인이다.
POST /sec-reprocess/NVDA는 호출하지 않았다. NVDA의 metadata/provenance를 운영에 저장하지 않았다.

## [12. NVDA Annual Metadata Coverage]

변경 전 총 10행. 새 fiscal_year/fiscal_period/period_start 열이 운영에 아직 없어 populated 집계는 미실행이다.
Phase 1.5 로컬 10/10 결과를 운영 결과로 대체하지 않았다.

## [13. NVDA Quarterly Metadata Coverage]

변경 전 총 40행. 새 열이 없어 populated 집계는 미실행이다.
로컬 40/40 결과를 운영 검증 성공으로 표시하지 않았다.

## [14. 핵심 Period]

2026-07-26 분기 행은 운영 baseline에 존재하지만 회사 FY/Q/Start 새 field 검증은 아직 하지 못했다.
2026-01-25 annual·quarterly는 각각 별도 행으로 baseline에 존재한다.
Q2 FY2027, FY2026 및 Q4 FY2026 판정은 Phase 1.5 로컬에서는 검증됐으나 이번 운영 검증은 미실행이다.

## [15. NVDA Provenance]

미실행. 0016 미적용으로 운영 출처 테이블 생성·8개 지표 출처 확인 단계에 도달하지 않았다.

## [16. NVDA Numeric Regression]

[8]에 Before 값을 기록했다. After는 재처리 미실행이므로 없다.
변경 건수를 0으로 검증 완료했다고 표시하지 않는다.
이번 실행이 숫자를 쓰지는 않았지만, 예정된 재처리가 숫자를 보존한다는 운영 실증은 아직 필요하다.

## [17. AAPL Smoke Test]

미실행. 변경 전 annual 10행, quarterly 40행.
운영 metadata coverage와 재처리 후 numeric 이상 여부는 미확인.

## [18. MSFT Smoke Test]

미실행. 변경 전 annual 10행, quarterly 40행.
운영 metadata coverage와 재처리 후 numeric 이상 여부는 미확인.

## [19. JPM Smoke Test]

미실행. 변경 전 annual 10행, quarterly 40행.
운영 metadata coverage와 재처리 후 numeric 이상 여부는 미확인.

## [20. O Smoke Test]

미실행. 변경 전 annual 10행, quarterly 40행.
운영 metadata coverage와 재처리 후 numeric 이상 여부는 미확인.

## [21. 180/60 Rule 영향]

운영 재처리가 없어 이번 운영 결과는 미확인. 기존 rule은 수정하지 않았다.
Phase 1.5의 결과는 참고일 뿐 운영 검증 완료로 표시하지 않는다.

## [22. 기존 API 호환성]

새 배포 후 호환성은 미검증. 이번 실행으로 운영 API 코드를 바꾸지 않았다.
새 metadata field의 공개 API 반환 확인도 미실행이다.

## [23. 기존 UI 영향]

1-1/1-2/1-3 UI 파일 변경 없음.
index.html, app.js, style.css, 차트·배당 코드는 수정하지 않았다.
브라우저 직접 조작 smoke test는 미실행이다. 변경 없음과 실제 UI 검증 성공은 구분한다.

## [24. 전체 Test 결과]

마지막 실행: 총 104개, PASS 104, FAIL 0.
npm run check 및 git diff --check 통과. 새 검증 Worker Node 문법 검사 통과.
원격 preview 오류 뒤에는 중단 지시에 따라 수정·재시도·추가 실행을 하지 않았다.
기존 unit test는 Cloudflare의 redirect 옵션 제한까지 검증하지 않아 원격 문제를 놓쳤다.

## [25. Production 변경 내역]

migration: NO.
worker production deployment: NO.
재처리 종목: 없음.
그 외 운영 DB write: NO.
운영 Secret write: NO.
운영 전체 데이터 export: NO.
read-only D1 상태·baseline·복구 북마크 조회와 비공개 Cloudflare preview 생성만 수행했다.
기존 운영 Cron의 독립적인 정상 갱신은 이번 작업이 시작한 write가 아니다.

이번 로컬 추가/변경:

- worker/src/fundamental-sync.js: SEC_FINANCIAL_ROLLOUT_MODE=manual일 때 전체 재무 큐의 외부 호출·DB 작업 보류.
- worker/wrangler.jsonc: 수동 검증 모드 설정. 아직 운영에는 배포하지 않음.
- scripts/sec-financial-rollout-worker.js: SEC-only 사전 확인·고정 5종목 단일 처리 전용 preview. 현재 redirect 옵션 오류가 있어 재사용 전에 수정 필요.
- scripts/sec-financial-rollout.wrangler.jsonc: 운영 SEC Secret 상속·D1 연결의 검증 preview 설정. production deploy용으로 사용하면 안 됨.
- tests/sec-financial-rollout.test.js: 안전장치 테스트 4개 추가. 런타임 옵션 호환 테스트 보완 필요.
- docs/sec-financial-phase1-6a-report.md: 현재 중단 상태와 복구·baseline 기록.

## [26. 전체 Backfill 실행 여부]

NO. 전 종목 loop, scheduler 강제 실행, SEC 전체 재수집은 하지 않았다.
지정된 5종목 POST도 아직 한 번도 실행하지 않았다.

## [27. 발견된 문제]

[PRODUCTION BLOCKER]

발생 단계: migration 이전, Cloudflare 원격 SEC 사전 확인.
정확한 오류: preview HTTP 500, Invalid redirect value; Cloudflare는 follow/manual만 지원.
현재 DB 상태: 이번 migration·write 없음. 사전 확인 당시 0015까지 적용, 재무 500행.
Worker 상태: production은 기존 배포 그대로. 실패한 preview 세션은 종료했다.
rollback 필요 여부: NO. 운영 변경이 없으므로 복구·롤백을 실행하지 않았다.

다음 안전 조치:
1. 검증 helper의 redirect를 manual로 바꾸고 redirect 응답을 오류로 처리한다.
2. Cloudflare 호환 옵션과 비 JSON 오류를 다루는 테스트를 추가한다.
3. 전체 테스트와 Cloudflare 사전 확인을 다시 통과시킨 뒤에만 0016 적용을 시작한다.
4. migration → 숫자 보존 확인 → deploy → NVDA → 나머지 4종목 순서를 유지한다.

이번에는 임의로 수정 후 재시도하지 않고 중단 상태를 먼저 보고한다.

## [28. Phase 1.6B 진행 가능 여부]

D에 해당하는 운영 적용 전 blocker: 기본 migration/deploy가 아직 실행되지 못해 수정 후 재개가 필요하다.
이미 실행한 migration/deploy가 실패했다는 뜻은 아니다. C의 운영 numeric regression도 발생하지 않았다.
Phase 1.6B 전체 backfill은 승인할 수 없다.

아래 NO는 실패 확정이 아니라, 필요한 운영 검증이 완료되지 않았음을 뜻한다.

| 최종 확인 | YES / NO |
| --- | --- |
| 1. production SEC 호출 정상 확인 | NO |
| 2. migration 0016 정상 적용 | NO |
| 3. migration 후 기존 숫자 보존 확인 | NO |
| 4. 새 Worker 정상 배포 | NO |
| 5. NVDA FY/FQ 운영 정상 확인 | NO |
| 6. NVDA provenance 운영 정상 확인 | NO |
| 7. NVDA numeric regression 0건 검증 | NO |
| 8. 추가 4종목 smoke test 정상 확인 | NO |
| 9. 기존 기능 유지 실증 확인 | NO · UI 변경과 운영 배포는 없음 |
| 10. 전체 backfill 시작 가능 | NO |
