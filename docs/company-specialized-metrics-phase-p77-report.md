# Phase P7.7 검증 기록 및 승격 실행 기준

## 범위와 시작 상태

시작 checkpoint는 `58df6221bf59aff529a1a0a6f1ad88d069ca0a93`이다. 시작 Git clean,
기존 628 tests 및 check/audit PASS를 확인했다. 이번 변경은 격리된 GET 검증 도구,
CPU 로그 상관 검증, 테스트 및 이 문서뿐이다. 기존 query service의 숫자/contract를 수정하지 않았다.
운영 migration, DB write, Worker/Pages deploy, Cron/Secret 변경, origin/main push는 실행하지 않는다.

## 실제 Free runtime

계정 대시보드의 Workers 요금제에서 현재 Free / US$0 / 요청당 CPU 10ms를 확인했다.
공식 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)도 재확인했다.
[Worker Previews](https://developers.cloudflare.com/workers/previews/)를 사용하여 새 임시 Worker에서
기존 P7.5 disposable remote D1에만 binding했다. 운영 config/Worker entry를 배포하지 않았다.
`workers_dev=false`, Cron 없음, write route 없음, 인증 hash 및 1시간 만료를 적용했다.
검증에 사용한 preview는 API 삭제 후 404를 확인했다. 빈 parent Worker는 활성 경로 없이 남는다.
Disposable D1은 P8 직전 재검증용으로 유지한다.

## 실제 CPU 로그 상관

CPU source는 Workers Observability actual invocation의 `cpuTimeMs`이다.
임시 probe ID, Worker 이름, preview ID와 HTTP 결과를 연결했다. 원시 header/토큰/IP는 저장하지 않는다.
CPU 조회용 파일은 Git 제외 여부와 미추적 여부를 확인한 뒤 메모리로만 읽는다.
credential 원문/길이/hash는 출력하지 않는다.

최종 HTTP 의미 검증 표본은 110건이다. 첫 99건 중 로그 한 건이 누락되어 annual NFFO를 11건 추가했다.
최종 로그 109건 중 warm-up 10건을 제외한 실제 측정 CPU는 99건이다.
누락 한 건을 숨기거나 삭제하지 않고 증거의 `missing`에 유지한다.
각 series마다 실제 CPU 10건 이상을 확보했다. 추가 NFFO 표본도 전부 포함했다.
일부 초기 preview 준비/전파 실패 및 로그 지연 재시도는 측정 표본과 분리해 기록했다.
실제 cold isolate인지 확정할 수 없으므로 cold/warm 격리 검증은 NOT VERIFIED다.

| series | 실제 CPU 표본 | CPU p50 / p95 / max (ms) | 응답 값 수 |
| --- | ---: | --- | ---: |
| Quarterly FFO | 10 | 2 / 3 / 3 | 40 |
| Quarterly AFFO | 10 | 2 / 4 / 4 | 40 |
| Quarterly NORMALIZED_FFO | 10 | 1 / 4 / 4 | 19 |
| Annual FFO | 10 | 1 / 2 / 2 | 10 |
| Annual AFFO | 10 | 1 / 2 / 2 | 10 |
| Annual NORMALIZED_FFO | 19 | 1 / 3 / 3 | 5 |
| YTD FFO | 10 | 1 / 2 / 2 | 20 |
| YTD AFFO | 10 | 1 / 2 / 2 | 20 |
| YTD NORMALIZED_FFO | 10 | 1 / 2 / 2 | 10 |

전체 측정 CPU p50=1ms / p95=3ms / max=4ms. warm-up 포함 max=6ms.
Cloudflare invocation wall p50=320ms / p95=355ms / max=361ms.
동일 99개 표본 D1 duration 합계/요청의 p50=1.7286ms / p95=3.9522ms / max=6.0926ms.
요청당 SELECT 2회, rows_read p50=362 / p95=max=830, rows_written=0.
클라이언트 왕복 시간은 별도이며 p50=485.91ms / p95=2275.30ms / max=13455.62ms였다.
클라이언트 왕복을 Worker CPU/wall로 환산하지 않는다. 최종 CPU 표본 outcome 오류는 0건이다.
이 측정은 specialized handler + 인증 + D1/직렬화에 대한 gate이며,
전체 운영 앱 router/middleware 비용은 P8 R8 smoke에서 추가 확인해야 한다.

## 의미 검증 및 회귀

기존 `querySpecializedMetrics`에 동일 disposable D1 REST adapter를 연결해 기준 응답을 만들고,
키 순서만 정규화한 semantic SHA-256을 실제 Worker 응답마다 비교했다. 9개 모두 동일했다.
values/unit/definitionVersion/validationStatus/provenance/definitionBoundaries를 제거하지 않았다.
`economicContinuityAssumed=false`를 유지했다. 최적화 또는 fixture 응답 대체는 하지 않았다.

최종 로컬 테스트 638 PASS / 0 FAIL (기존 628 + 신규 10).
`npm run check`, `p75:check`, `p76:check`, `p77:check`, `git diff --check` PASS.
기존 specialized audit 7개는 repo 밖 기존 cache로 실행했으며 네트워크 원문 재다운로드는 없다.
40/40 parser, 14 definitions / 950 values / 1,344 provenance,
162 validated / 788 parsed, 기존 protected financial/classification digest를 보존한다.
Disposable CLI verify-only: completed, rows_written=0, 같은 combined digest 유지.

combined semantic digest:
`4cfa78a3a02c42cf9b7a8c021772ca596c3789a14b375b7eb504da8711a73ed5`

## 운영 읽기 전용 preflight

2026-10-01 검증에서 migrations=0001~0016, companies=10,
financial_metrics=500, financial_metric_provenance=5,223, ready queue=20,
SEC_FINANCIAL_ROLLOUT_MODE=normal (ACTIVE)를 확인했다.
운영 deployment/version은 기존 값 그대로이며 실제 module hash도 동일했다.
Cron 5개는 로컬 config 및 이전 검증 결과와 일치한다. 읽기 전용 D1 rows_written=0.
P8 시작 직전에 다시 preflight하며 drift가 있으면 envelope 유무와 관계없이 중단한다.

## 실제 원격 백업 절차와 증거 위치

기존 origin은 Pages 및 Worker Builds와 연결되어 있어 어떠한 branch에도 push하지 않는다.
새 private GitHub backup repository를 만들었다. 업로드 전 API에서 private=YES,
Actions workflow=0, webhook=0을 확인했다. Cloudflare 전체 앱 목록과 Worker Build 설정,
Pages API에서 production 연결은 기존 origin만이며 backup repository 연결은 없음을 확인했다.
Worker Builds API 권한 오류를 연결 확인 성공으로 간주하지 않고 대시보드의 실제 연결 정보로 확인했다.

코드 checkpoint가 clean인 상태에서 `git bundle --all`을 만들고 verify/hash를 확인한다.
Git tracked 전체 history와 staged 파일의 민감정보를 검사해야 한다.
PDF/cache/12MB import artifact/.dev.vars/credential/실제 이메일은 bundle에 포함하지 않는다.
검증한 비공개 backup repository에만 bundle 파일을 업로드한다.
다시 다운로드해 SHA-256 일치, bundle verify 및 repo 밖 임시 clone HEAD 일치를 확인한다.
업로드 후 private/Actions/webhook을 다시 확인한다.

최종 checkpoint/bundle hash/실제 업로드/복구 결과는 commit hash의 순환 참조를 피하기 위해
Git 제외된 `backups/p77/backup-results.json` 및 `backups/p77/final-report.md`에 기록한다.
이 문서의 절차만으로 업로드 완료나 승격 승인을 주장하지 않는다.

## Promotion envelope

CPU, 의미 검증, 실제 원격 백업/복구, production no-drift,
importer/0019 regression, disposable digest, Git clean이 전부 PASS일 때만 생성한다.
별도 production identity에 승인하는 것이며 rehearsal 승인을 재사용하지 않는다.
기존 importer의 exact identity와 호환되도록 target DB ID를 로컬 승인 파일에 포함해야 한다.
DB ID는 credential이 아니지만 최종 표시에서는 SHA-256/마스킹하고, 실제 Secret은 포함하지 않는다.
artifact bytes SHA와 artifact semantic hash를 구분하고 combined DB digest도 별도 명시한다.
`loadImportArtifact`로 승인 파일을 오프라인 검증한다. 승인 metadata 생성은 실제 apply/deploy가 아니다.

## 조건부 P8 순서

- R0: 최종 checkpoint 및 검증된 remote backup 확인.
- R1: production preflight, 신규 Time Travel bookmark 확보.
- R2: 0017만 적용 후 schema/API/numeric regression.
- R3: 0018만 적용 후 동일 regression.
- R4: 0019만 적용 후 coordination schema 검증.
- R5: classification CLI verify-only → 명시 apply → Run2 verify-only.
- R6: historical CLI verify-only → immutable artifact apply → 문서별 검증 → Run2 verify-only.
- R7: 14/950/1344, 162/788, digest, duplicates/conflicts/orphans 0 확인.
- R8: Worker/API 수동 배포, 기존 API 회귀, 전체 router 포함 specialized GET CPU/runtime smoke.
- R9: 기존 pipeline 동작 관찰.
- R10: Pages/UI는 별도 승인 후 배포.
- R11: 자동 deploy 영향 정리 및 별도 승인 후 origin/main push.

위 순서는 이번 Phase에서 실행하지 않는다. 원격 백업과 envelope 결과까지 완료된 경우에만
P8 시작 가능 판정을 내리며 실제 운영 rollout은 다음 요청에서 진행한다.

## 최초 백업 중단과 사용자 예외 승인

최종 staged 파일 8개와 전체 Git history의 파일 본문 483 blobs / 7,544,983 bytes에서는
실제 credential/이메일이나 금지된 cache/PDF 경로를 발견하지 않았다.
그러나 commit 메타데이터 검사에서 과거 7개 commit의 실제 author/committer 이메일을 발견했다.
이메일 원문은 출력하거나 결과 파일에 저장하지 않았다. Git bundle은 이 메타데이터도 포함한다.
최초 실행에서는 전체 이력 민감정보 금지 조건에 따라 `[GIT BLOCKER]`로 중단했다.
당시 신규 checkpoint, bundle 업로드, promotion envelope는 만들지 않았으며 Git 이력도 수정하지 않았다.
이후 사용자가 기존 7개 commit의 author/committer 이메일 메타데이터만 비공개 백업에 포함하는 예외를 승인했다.
commit 객체를 검사할 때 승인된 기존 commit의 두 identity 행에만 예외를 적용한다.
commit message, 파일 본문, 신규 commit, API key/token/환경파일/cache/PDF에는 예외를 적용하지 않는다.
새 checkpoint에는 실제 이메일을 추가하지 않는 일회성 Git identity를 사용하며 기존 hash는 변경하지 않는다.
예외 승인 후 검증/백업/복구/envelope의 실제 최종 결과는 Git 제외된 `backups/p77/final-report.md`에 기록한다.
업로드 전후 private/Cloudflare 미연결/workflow/webhook 조건을 다시 확인해야 한다.
