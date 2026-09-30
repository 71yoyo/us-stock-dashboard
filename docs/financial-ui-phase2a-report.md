# 재무 UI Phase 2A 로컬 구현·검증 보고서

검증일: 2026-09-30. 안정 checkpoint `6983d71` 이후 재무 UI만 변경했다. 이번 변경은 아직 커밋·배포하지 않았다.

## [1. 시작 상태]

- 시작 시 `git status --short`: clean.
- checkpoint: `6983d71` / `SEC financial metadata and provenance rollout`.
- 시작 시 `npm test`: 기존 117 PASS / 0 FAIL. `npm run check`: PASS.

## [2. Chart Library]

Apache ECharts 6.0.0을 버전 고정 CDN과 SHA-384 SRI로 도입했다. 빌드 없는 정적 앱을 유지하고 재무 탭에 들어갈 때만 로딩한다. npm 패키지 설치·React 전환·TradingView 개조는 하지 않았다. 연결 실패 시 요약값을 유지하고 재시도 버튼을 표시한다.

공식 참고: [축과 복합 차트](https://echarts.apache.org/handbook/en/concepts/axis/), [크기·resize·dispose](https://echarts.apache.org/handbook/en/concepts/chart-size/), [라이브러리 추가 방식](https://echarts.apache.org/handbook/en/basics/import/).

## [3. 수정 파일]

- `index.html`: 재무 selector와 성장·수익성 패널, 모듈 로딩.
- `app.js`: 재무 모듈 연결, 종목·탭·모달 생명주기 연결만 변경.
- `style.css`: 재무 패널에 한정된 반응형 스타일.
- `financial-chart.js`: 데이터 변환·계산·option·tooltip·로딩·instance 관리.
- `package.json`: 새 모듈·로컬 검증 도구를 문법 검사 대상에 추가.
- `tests/financial-chart.test.js`: 신규 차트 테스트 22개.
- `tests/financial-ui-regression.test.js`: 기존 저장·백업 회귀 테스트 3개.
- `scripts/financial-chart-preview.mjs`: 실제 저장 데이터를 읽어 메모리에 보관하는 로컬 UI 검증 서버.
- 이 보고서.

## [4. Financial UI 구조]

기존 큰 3×4 재무 카드 영역을 제거했다. selector 순서는 성장·수익성, 영업이익, EPS, PEG, PER, P/S, 잉여현금흐름, ROE, ROIC, Gross Margin, Oper. Margin이다. 줄바꿈 없이 가로 스크롤하며 성장·수익성만 활성화했다. 나머지는 비활성·제공 예정 상태이고 가짜 차트가 없다.

## [5. Growth & Profitability Chart]

매출은 청록색 Bar, 순이익은 파란색 Bar로 나란히 표시한다. 순마진은 초록색 Line이다. 금액은 왼쪽 축, 순마진은 오른쪽 % 축을 사용한다. 세 항목의 legend와 최신 선택 기간 요약을 표시한다. 기존 `company.financials`만 읽는다.

## [6. Annual]

기본은 연간이다. `periodType === 'annual'`에서 최근 10개를 오래된 순으로 표시한다. X축은 저장된 `fiscalYear`로 만든 FY 라벨이다. NVDA 실제 화면에서 FY2017~FY2026 10개를 확인했다. 부족한 이력은 만들어 채우지 않는다.

## [7. Quarterly]

저장된 `fiscalPeriod`와 `fiscalYear`로 Q/FY 라벨을 만든다. 기본 12Q이며 8Q·12Q·20Q·전체 버튼을 검증했다. NVDA 전체 40개를 유지한다. 20Q/전체에서는 slider와 inside dataZoom으로 최근 12개부터 보여주고 과거 구간으로 이동할 수 있다. 확대 구간에 따라 축 범위도 다시 맞춘다.

## [8. Tooltip]

`trigger: 'axis'` 공유 툴팁에 FY/Q, 매출, 순이익, 순마진, 기간 시작~종료일, 공시일, 전년 대비, 분기의 전분기 대비를 함께 표시한다. 없는 값은 —로 표시하고 날짜를 추정하지 않는다. 문자열은 HTML 이스케이프한다.

## [9. YoY/QoQ]

변화율은 `(현재 - 이전) / abs(이전) × 100`이다. 연간 YoY는 전년 FY, 분기 YoY는 같은 Q의 전년 FY, QoQ는 바로 이전 Q/FY를 매칭한다. 배열 4칸 전을 무조건 사용하지 않는다. 이전값 누락·0 또는 비유한 계산값은 null이다. 손실 기준 변화율을 성장·좋음으로 단정하거나 색으로 강조하지 않는다.

## [10. Number Formatting]

재무 전용 함수로 K/M/B/T와 %를 표시한다. 예: `$96.22B`, `$130.50B`, `62.03%`, `-$1B`. 기존 가격·배당 포맷터는 변경하지 않았다.

## [11. Responsive]

브라우저에서 1366×900, 768×1024, 390×844를 검증했다. 모바일 재무 패널 322px, 차트 300×380px에서 패널 가로 넘침이 없고 selector는 가로 스크롤한다. ResizeObserver와 window resize로 차트 크기를 갱신한다. computer-use 스킬을 적용해 실제 화면과 반응형 동작을 확인했다.

## [12. Ticker Switching]

종목 변경 시 기존 instance를 dispose하고 연간·12Q 기본 상태로 초기화한다. 새 상세 데이터를 기다리는 동안 이전 재무 차트도 비운다. 로딩 중 닫기·탭 변경·종목 교체 뒤 도착한 응답은 차트를 재생성하지 않는다. 연간/분기 toggle은 같은 instance를 갱신한다. 모달 닫기 뒤 canvas 0개를 실제 확인했다.

## [13. Missing/Negative Data]

매출·순이익 누락은 null, 실제 0은 0으로 유지한다. 매출 0 또는 매출/순이익 누락 시 순마진은 null이다. 음수 막대·순마진은 원값을 유지하고 축은 0 baseline을 포함한다. null 구간의 선은 연결하지 않는다. 이력이 전부 없으면 수집 현황 확인 안내를 표시한다.

## [14. NVDA 검증]

운영의 기존 공개 회사 API를 GET으로 읽고 로컬 검증 서버 메모리에 보관했다. 운영 데이터 쓰기는 하지 않았다.

- Annual: 실제 10개, FY2017~FY2026.
- Quarterly: 실제 40개, 기본 최근 12Q.
- 최신 종료일 `2026-07-26`: **Q2 FY2027** 정상 표시.
- Revenue: `96,221,000,000` → `$96.22B`.
- Net Income: `59,688,000,000` → `$59.69B`.
- Net Margin: 동일 row의 실제 나눗셈 → `62.03%`.
- 기간: `2026-04-27 ~ 2026-07-26`, 공시일: `2026-08-26`.
- 최신 툴팁: 매출 QoQ +17.90%, 순이익 QoQ +2.34%, 매출 YoY +105.85%, 순이익 YoY +125.90%.

## [15. 다른 종목 Smoke Test]

5종목 모두 브라우저에서 실제 저장된 연간 10개·분기 기본 12Q·공유 툴팁을 확인했다.

| 종목 | 최신 분기 | 매출 | 순이익 | 순마진 |
| --- | --- | --- | --- | --- |
| AAPL | Q3 FY2026 | $109.42B | $29.79B | 27.23% |
| MSFT | Q4 FY2026 | $90.01B | $35.77B | 39.74% |
| JPM | Q2 FY2026 | $57.35B | $21.16B | 36.89% |
| O | Q2 FY2026 | $1.55B | $370.51M | 23.94% |
| TSLA | Q2 FY2026 | $28.24B | $1.11B | 3.95% |

## [16. 기존 기능 영향]

- 1-1: 기존 TradingView 모듈·설정·시간 단위는 수정하지 않았다. 재무 탭을 나가면 iframe이 다시 생성되는 것을 확인했다.
- 1-3: 배당 HTML·렌더링·데이터 로직은 수정하지 않았고 재무 canvas가 제거된 배당 탭을 확인했다.
- PIN: 로컬 브라우저 잠금·해제·새로고침 후 재진입을 확인했다. PIN 구현·저장 키는 수정하지 않았다.
- 관심목록: 기존 순서 변경·삭제·localStorage 직렬화 함수를 격리 회귀 테스트로 검증했다.
- 포트폴리오: 기존 입력 이벤트·저장 함수·JSON 재로딩 형식을 격리 테스트로 검증했다.
- JSON backup: 기존 다운로드 Blob과 복원 이벤트를 격리 테스트로 왕복 검증했다.
- 실제 사용자 관심목록·보유 내역·PIN은 테스트에 읽거나 쓰지 않았다. 저장·백업 검증은 메모리 DOM/저장소에서 진행했으며 실제 브라우저 업로드까지 검증한 것은 아니다.

## [17. Test 결과]

- 기존 테스트: 117개 유지·통과.
- 신규 테스트: 차트 22개 + 기존 UI 회귀 3개 = 25개 통과.
- 총 142 PASS / 0 FAIL, skipped 0.
- `npm run check`: PASS, 새 모듈과 검증 스크립트 포함.
- `git diff --check`: PASS. Windows 줄바꿈 자동 변환 경고는 있으나 공백 오류는 없다.

## [18. Production 변경]

DB write: **NO**. Worker deploy: **NO**. Pages deploy: **NO**. commit/push: **NO**.

Worker 코드·migration·ingestion·scheduler·수치 선택·provenance는 변경하지 않았다. 로컬 검증 서버는 쓰기 요청을 405로 차단하고 저장된 공개 API 응답만 읽는다. 따라서 로컬 수집 상태의 0/0 표시는 테스트용 상태이며 운영 상태를 의미하지 않는다.

## [19. 발견된 문제]

재무 모듈에서 발생한 브라우저 오류는 관찰되지 않았다. 별도의 외부 TradingView iframe에서 `SyntaxError: "[object Object]" is not valid JSON` 오류 한 건을 관찰했다. 해당 모듈은 이번에 수정하지 않았으며 이번 재무 UI 검증만으로 기존 오류인지 원인을 확정하지 않았다. 1-1 수정 금지 범위이므로 임의 수정하지 않았다. ECharts CDN 장애는 요약값 유지·재시도 안내로 처리하나 인터넷이 없으면 실제 차트는 표시할 수 없다.

## [20. 다음 Phase 제안]

같은 chart shell을 영업이익·EPS·FCF·ROE·Gross Margin·Operating Margin으로 단계적으로 확장할 준비는 됐다. 각 항목의 저장 단위·누락·계산 정의를 먼저 확인하고 지표별 option과 tooltip을 추가하면 된다. 현재는 다른 지표의 차트나 PER/P/S/PEG·ROIC 계산을 구현하지 않았다.

## 최종 YES/NO

1. 기존 카드 UI가 metric selector 구조로 변경됐는가? **YES**
2. 성장·수익성 combo chart가 구현됐는가? **YES**
3. Annual 10년이 정확한 FY로 표시되는가? **YES**
4. Quarterly FY/Q가 정확한가? **YES**
5. Q2 FY2027이 정상 표시되는가? **YES**
6. Shared tooltip이 작동하는가? **YES**
7. 8Q/12Q/20Q/전체가 작동하는가? **YES**
8. 다른 ticker에서도 작동하는가? **YES**
9. 기존 1-1/1-3 기능이 유지되는가? **YES** — 코드·기존 테스트 유지, 외부 iframe 오류는 위에 별도 기재.
10. 다음 metric 확장 Phase로 넘어갈 준비가 되었는가? **YES** — 이번에는 로컬 구현·검증까지만 완료.
