# P7.5 이후 운영 실행 계획 — 승인 보류

이번 문서는 실행 승인이 아니다. 운영 DB·Worker·Pages·Cron·Secret은 변경하지 않았다.

## 확인된 자동배포 위험

- `71yoyo/us-stock-dashboard`의 `main` push는 Pages와 Worker 양쪽 운영 배포를 시작한다.
- Pages는 정적 앱을 repo root `.`에서 배포하고 모든 경로를 감시한다.
- Worker는 `npm install` 후 `npx wrangler deploy --config worker/wrangler.jsonc`를 실행한다.
- 비운영 branch도 Pages preview 및 Worker version upload 대상이다. 승인 전 push 자체를 하지 않는다.
- `.github/workflows/verify.yml`은 검사만 실행한다. 조사된 Cloudflare 계정에는 Pages 1개와 운영 Worker 1개가 있다.

## 남은 승인 조건

1. 실제 Free invocation 예산이 적용되는 비공개 실행 경로와 remote CPU 계측을 확보한다. private `wrangler dev --remote` 성공은 50회 제한/10ms CPU 통과 증거가 아니다.
2. 전용 single-writer lease를 운영에 연결할 schema/내부 importer 검토가 필요하다. 시험용 `p75_*` schema를 그대로 운영 migration에 복사하지 않는다.
3. profile writer barrier를 구현·검증한다. scheduler뿐 아니라 `/api/sync`와 수동 backfill도 포함한다. 기존 manual queue mode만으로는 충분하지 않다.
4. 공개 데이터 조회 route는 additive contract 및 read-only 정책 검증 후 별도 승인한다.

## Single-writer 선택

기존 fundamental job lease는 queue job TTL이며 dataset 단위 fence와 문서 transaction 소유권을 보장하지 않는다.
Durable Object는 추가 deployment/binding·비용·DB transaction 연계 검토가 필요하다.
현재 구조에는 D1 전용 lease table 방식이 적합하다. lock key는 importer 전체, dataset은 immutable artifact identity,
owner·expiry·renewal·단조 증가 fence·release를 보존한다. DB 시각으로 batch 시작/끝에 소유권을 확인하고
stale owner는 constraint 실패로 batch 전체를 rollback한다. 보호 guard row 부재도 실행 전 차단해야 한다.

**[PRODUCTION SCHEMA CHANGE REQUIRED]** 운영 migration은 아직 작성하거나 실행하지 않았다.

## 승인 이후 권장 순서

1. 로컬 checkpoint 및 전체 검증 → 별도 rollout 승인. GitHub push 금지 유지.
2. Pages/Worker Git 자동배포를 일시 정지하는 승인 및 실제 변경 여부 확인.
3. 운영 백업/bookmark·기존 재무 numeric digest 확보. import 외 profile writer의 scheduler/API/backfill barrier 적용.
4. 0017만 적용 → schema/constraint/index 확인 → classification 10종목 backfill 및 재실행·override 검증.
5. 0018만 적용 → schema/FK/constraint/index 확인 → 별도 검토된 lease schema 적용.
6. 비공개 내부 importer만 준비. public route·Cron에 연결하지 않고 artifact hash와 DB identity를 재확인한다.
7. 단일 owner, concurrency=1로 O 역사 문서 atomic import·즉시 읽기 검증 → Run2·SQLite digest·query 검증.
8. 호환 Worker/API를 수동 배포 → 기존 1-1/1-3·재무 숫자·profile override·읽기 contract 회귀 검증.
9. profile writer barrier 해제 → scheduler/manual writer가 현재 metadata와 분류를 함께 저장하는지 확인.
10. UI/Pages는 별도 승인 후 배포. 아직 specialized UI 구현/공개 승인이 없으므로 이번 단계에 포함하지 않는다.
11. 승인된 commit push 시점을 배포 완료 후로 둔다. 자동배포 재활성화 전 동일 승인된 revision인지 확인한다.

## 실패·복구

- 실패 문서는 atomic rollback, 이전 성공 문서는 보존한다. resume의 기본은 동일 immutable artifact 전체 rerun이다.
- 네트워크/일시 과부하만 최대 2회 backoff+jitter. 값/정의 충돌·hash mismatch·lease loss·constraint 의미 오류는 즉시 중단한다.
- Time Travel은 운영 DB 전체 상태에 영향을 주므로 단일 문서 오류에 즉시 실행하지 않는다. 운영 restore는 별도 승인이 필요하다.
- rehearsal DB는 승인 검토 완료까지 유지한다. private preview는 검사 후 종료하고 public route를 남기지 않는다.
