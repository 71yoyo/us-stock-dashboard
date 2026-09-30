# 재무 UI Phase 2B 구현·로컬 검증 보고서

검증일: 2026-09-30. 이번 작업은 재무 탭의 UI만 변경했다. 실제 저장 데이터는 공개 회사 API의 GET 응답을 읽었으며, 로컬 검증 서버의 메모리에서 사용했다. production 쓰기·배포·커밋은 하지 않았다.

## [1. 시작 상태]

- checkpoint: `3e60e0a` / `Implement financial growth and profitability chart`.
- 시작 시 `git status --short` 출력 없음: clean.
- 기존 `npm test`: 142 PASS / 0 FAIL.
- 기존 `npm run check`, `git diff --check`: PASS.

## [2. 수정 파일]

- `financial-chart.js`: 공통 metric 설정, 단일 지표 option·tooltip·summary·선택 상태.
- `index.html`: 세 selector 활성화, `aria-pressed`, 단일 summary, 정적 캐시 버전.
- `style.css`: 재무 패널 내부 단일 summary 색상 한 규칙.
- `tests/financial-metrics.test.js`: 신규 33개 테스트.
- `docs/financial-ui-phase2b-report.md`: 이 보고서.

`app.js`, Worker, migration, normalization, ingestion, provenance, fiscal metadata, scheduler, Cron, API contract, production 설정은 변경하지 않았다.

## [3. Metric Config 구조]

`financialMetricConfigs`에 각 항목의 `label`, `title`, `field`, `unit`, `chartType`을 정의했다. 개별 지표는 공통 데이터 준비, 범위, formatter, tooltip, controller를 사용한다. 마진은 저장된 퍼센트 값을 읽으며 재계산하거나 100배 보정하지 않는다. 현재 정적 앱을 React·TypeScript로 전환하지 않았다.

## [4. Selector]

활성: 성장·수익성, 영업이익, Gross Margin, Oper. Margin.

비활성: EPS, PEG, PER, P/S, 잉여현금흐름, ROE, ROIC. 실제 `disabled` 상태이며 클릭 처리에서도 비활성·미등록 항목을 차단한다. 활성 항목은 기존 active 스타일과 `aria-pressed`를 사용한다. 페이지 reload 없이 같은 패널의 내용만 변경한다.

## [5. Operating Income]

Annual 최근 10FY와 Quarterly 8Q/12Q/20Q/전체에 금액 bar를 표시한다. 왼쪽 금액 축 하나를 사용하고 K/M/B/T로 포맷한다. 음수는 부호를 유지하고 0선 아래에 표시한다. null은 null이며 전체 누락이면 빈 상태를 표시한다.

## [6. Gross Margin]

Annual/Quarterly의 `grossMargin` 저장값을 퍼센트 bar와 단일 퍼센트 축으로 표시한다. 음수·null을 보존한다. `grossProfit / revenue`로 대체 계산하지 않는다.

## [7. Operating Margin]

selector는 Oper. Margin, 상세 제목은 Operating Margin이다. Annual/Quarterly의 `operatingMargin` 저장값을 퍼센트 bar로 표시한다. 음수·null을 보존하고 새로운 계산 정책은 만들지 않았다.

## [8. Shared Chart Shell]

기존 panel, host, ECharts instance, 기간·범위 selector, dataZoom, dark theme, grid, font, tooltip 스타일을 재사용한다. 단일 지표만 series·축·legend를 설정에서 바꾼다. metric 변경은 기존 instance의 `setOption(..., { notMerge: true })`를 사용해 이전 이중 축·series가 남지 않게 한다. 단일 legend는 숨기고 성장·수익성의 3-series legend는 유지했다.

## [9. Annual/Quarterly State]

metric 변경 시 Annual/Quarterly 및 선택 범위를 유지한다. 같은 기간을 지표 간 비교하기 위한 선택이다. summary는 해당 mode의 최신 기간을 표시하며, 최신값이 null이면 과거의 정상값으로 대체하지 않는다.

## [10. Range Selector]

Annual은 최근 10개이며, Quarterly는 8Q/12Q/20Q/전체를 공통 로직으로 처리한다. 기본 분기 범위는 12Q다. 전체는 현재 확보된 40분기를 사용하며 20Q/전체의 dataZoom은 기존 정책을 유지한다. X축은 저장된 `fiscalYear`와 `fiscalPeriod`만 사용한다.

## [11. Tooltip]

세 지표 모두 axis trigger 기반 shared tooltip을 사용한다. 표시 항목은 FY 또는 Q/FY, 선택 지표명·값, YoY 변화 (%), 분기인 경우 QoQ 변화 (%), 기간 시작·종료일, 공시일이다. null 값·계산 불가능 변화율은 `—`다.

NVDA Q2 FY2027 실제 검증:

| 지표 | 표시값 | QoQ 변화 | YoY 변화 |
| --- | --- | --- | --- |
| 영업이익 | $63.73B | +19.05% | +124.10% |
| Gross Margin | 74.98% | +0.06% | +3.52% |
| Operating Margin | 66.24% | +0.98% | +8.87% |

기간 `2026-04-27 ~ 2026-07-26`, 공시일 `2026-08-26`을 확인했다.

## [12. YoY/QoQ]

기존 `percentageChange`를 재사용한다: `(current - previous) / abs(previous) × 100`.

Annual은 이전 FY, Quarterly YoY는 이전 FY의 같은 Q, QoQ는 직전 회계분기에 대응한다. 이전값이 null/0이거나 비유한 결과이면 null이다. 마진의 변화도 %p가 아닌 % 변화이며 source 안내와 중립적인 tooltip 문구로 구분했다.

## [13. Empty State]

모든 선택값이 null이면 chart를 dispose하고 `이 기간에 사용할 수 있는 데이터가 없습니다. 5-3 수집 현황을 확인해 주세요.`를 표시한다. summary는 `—`, 이전 종목·지표의 접근성 설명은 남기지 않는다. 부분 null은 기간을 유지하고 해당 bar만 gap 처리한다. 정상 지표로 돌아가면 다시 차트를 생성한다.

## [14. Ticker Switching]

활성 metric을 유지한다. 종목 변경 시 기존 Phase 2A 방식대로 Annual·12Q로 초기화하고 이전 instance를 dispose한다. 모달 닫기·탭 변경 및 늦게 도착한 라이브러리 로딩 응답 처리도 유지했다. NVDA→AAPL을 포함한 실제 전환 및 격리 controller 테스트를 통과했다.

## [15. Responsive]

computer-use 스킬을 사용해 실제 로컬 브라우저에서 확인했다.

- Desktop: 1366×900, 정상 표시.
- Tablet: 768×1024, 패널 약 692px, 차트 약 667px, 안정 상태 가로 넘침 없음.
- Mobile: 390×844, 패널 약 337px, 차트 약 315×380px, 안정 상태 가로 넘침 없음.
- selector의 가로 스크롤을 유지했다. 임시 viewport override는 검증 후 해제했다.

## [16. NVDA 실제 검증]

API 응답을 읽어서 검증했으며 표시값을 코드에 하드코딩하지 않았다.

| 지표 | Q2 FY2027 원값 | 분기 표시 | FY2026 연간 표시 |
| --- | --- | --- | --- |
| operatingIncome | 63734000000 | $63.73B | $130.39B |
| grossMargin | 74.97531723844068 | 74.98% | 71.07% |
| operatingMargin | 66.23710000935347 | 66.24% | 60.38% |

네 활성 selector, Annual/Quarterly, 세 신규 지표 각각의 8Q/12Q/20Q/전체와 tooltip을 직접 확인했다.

## [17. AAPL/MSFT/JPM/O/TSLA Smoke Test]

각 종목의 세 신규 지표를 Annual/Quarterly로 확인했다. 5종목×3지표×2mode = 30개 화면 조합을 확인했다.

| 종목 | 최신 분기 | 영업이익 | Gross Margin | Operating Margin | 결과 |
| --- | --- | --- | --- | --- | --- |
| AAPL | Q3 FY2026 | $35.70B | 50.06% | 32.62% | 정상 |
| MSFT | Q4 FY2026 | $40.60B | 67.20% | 45.11% | 정상 |
| TSLA | Q2 FY2026 | $398M | 16.83% | 1.41% | 정상 |
| JPM | Q2 FY2026 | — | — | — | 명확한 빈 상태 |
| O | Q2 FY2026 | — | — | — | 명확한 빈 상태 |

JPM/O의 세 필드는 확보된 Annual 10개·Quarterly 40개 모두 null이었다. 가짜 값이나 별도 산식을 사용하지 않았다. 실제 TSLA FY2017의 영업이익 `-$1.63B`, Operating Margin `-13.88%`도 0선 아래 bar와 tooltip 부호를 확인했다.

## [18. Growth & Profitability Regression]

checkpoint `3e60e0a`의 순수 option·tooltip과 현재 결과를 실제 NVDA 자료로 직접 비교했다. Annual 및 분기 네 범위×desktop/compact, 총 10조합의 직렬화 option과 모든 tooltip 문자열이 같았다.

브라우저에서 Annual 최근 10FY, Quarterly 12Q, Q2 FY2027, 세 series, summary, shared tooltip을 재검증했다. 최신 분기 매출 `$96.22B`, 순이익 `$59.69B`, 순마진 `62.03%`가 유지되었다. 순마진 산식도 변경하지 않았다.

## [19. 기존 기능 Regression]

- 1-1: 실제 로컬 브라우저에서 TradingView iframe·화면 진입 확인.
- 1-3: 배당 탭 표시, 재무 canvas 해제 확인.
- PIN: 실제 잠금·해제 확인.
- 모달: 열기·닫기, 종목 전환 확인.
- 관심목록: 기존 격리 테스트의 순서 변경·삭제·저장 형식 유지, 추가·중복·빈 입력은 별도 격리 진단 통과.
- 포트폴리오: 기존 격리 테스트의 저장·재로딩 통과.
- JSON backup: 기존 격리 테스트의 다운로드 생성·복원 왕복 통과.

포트폴리오/backup의 사용자의 실제 데이터를 브라우저에서 덮어쓰지 않았다. 기존 localStorage·JSON 형식, 앱 로직은 변경하지 않았다. 최종 로컬 브라우저의 error/warn 로그 조회 결과는 0건이었다.

## [20. Test 결과]

- 기존 테스트: 142개 유지.
- 신규 테스트: 33개.
- 총 PASS: 175 / FAIL: 0 / SKIP: 0.
- `npm run check`: PASS.
- `git diff --check`: PASS.
- 신규 파일도 별도로 줄 끝 공백을 검사했다.

신규 테스트는 config, formatter, 원값 보존, FY/Q, 네 범위, YoY/QoQ, null/0/음수/비유한 값, all-null, partial-null, controller 상태·instance·ticker·접근성, 비활성 selector, 최신 summary, 성장·수익성 회귀를 다룬다.

## [21. Production 변경]

| 항목 | 실행 |
| --- | --- |
| production DB write | NO |
| Worker deploy | NO |
| Pages deploy | NO |
| migration | NO |
| commit/push | NO |

## [22. 발견된 문제]

JPM/O는 저장된 영업이익·두 마진의 원값이 null이다. 이번 UI scope에서는 수집·정규화 정책을 변경하지 않고 빈 상태로 처리했다.

열린 desktop tooltip을 유지한 채 mobile 크기로 바꾸면 resize 직후 잠깐 이전 위치가 남는 현상을 관찰했다. 이후 ECharts의 재배치가 완료된 안정 상태에서는 패널·차트의 가로 넘침이 없었다. 기존 Phase 2A tooltip 동작이며 이번에 공통 차트 정책을 변경하지 않았다. 고정 viewport에서 기능을 막는 문제는 발견되지 않았다.

## [23. 다음 단계 제안]

현재 6종목의 저장값 확보 상태를 기준으로 **ROE → EPS → FCF** 순서를 제안한다. 아직 구현하지 않았다.

- ROE: 6종목 모두 Annual 10/10·Quarterly 40/40 확보. 연간/분기 저장값의 의미·산식을 확인한 뒤 그대로 표시하는 확장이 가장 단순하다.
- EPS: Annual은 모두 10/10. Quarterly는 NVDA 34/40, AAPL 35/40, MSFT 34/40, JPM 30/40, O 33/40, TSLA 30/40. 누락 분기를 임의 계산하지 않는 정책이 필요하다.
- FCF: Annual/Quarterly 확보가 NVDA 5/10·32/40, AAPL 10/10·40/40, MSFT 10/10·39/40, TSLA 10/10·36/40, JPM/O 0/10·0/40이다. 금융업·REIT의 의미와 누락 처리를 먼저 합의하는 편이 안전하다.

다음 UI 확장을 위한 구조·검증 기반은 준비되었지만, 이번 결과 검토와 별도 checkpoint 승인 전에는 커밋·배포하지 않는다.

## 최종 YES / NO

1. 영업이익 selector 활성화 성공? YES
2. Gross Margin selector 활성화 성공? YES
3. Operating Margin selector 활성화 성공? YES
4. 3개 지표 모두 Annual 정상? YES — 저장값 없음은 빈 상태.
5. 3개 지표 모두 Quarterly 정상? YES — 저장값 없음은 빈 상태.
6. Shared Tooltip 정상? YES
7. 8Q/12Q/20Q/전체 정상? YES
8. Missing/Negative 처리 정상? YES
9. Phase 2A 성장·수익성 regression 없음? YES
10. 다음 Phase로 넘어갈 준비가 되었는가? YES — 검토·checkpoint 이후, 다음 지표의 데이터 의미·누락 정책 확인 조건.
