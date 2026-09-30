# Realty Income 최근 공식 HTML fixture

SEC EX-99.1 두 문서에서 FFO/Normalized FFO 및 AFFO 조정표만 발췌했다.
전체 문서 약 600KB씩 대신 필요한 두 표 약 21KB씩만 보관한다.
원문의 행·셀·숫자·colspan/rowspan은 유지하고 표시용 태그/스타일을 제거했다.
표 제목과 공통 단위 설명은 공식 표에서 확인한 텍스트를 발췌 앞에 붙였다.
기계적 발췌/표시 태그 제거와 별도로 numeric 값은 수정하지 않았다.

- `fy2025.html`: accession `0000726728-26-000009`의 EX-99.1.
- `q2-2026.html`: accession `0000726728-26-000044`의 EX-99.1.
- `*.source.json`: 전체 원문 SHA-256, 발췌 SHA-256, 실제 조회 시각 및 SEC 출처.
- `official-expected.json`: FY2025 / Q2 3개월 / Q2 6개월, 각 12건의 독립 공식 검증값.

전체 원문 hash는 취득한 HTML 문자열의 UTF-8 SHA-256이다. 발췌 hash와 구분하며
전체 원문을 fixture라고 가장하지 않는다. 테스트는 네트워크를 사용하지 않는다.
공식 표의 비교연도/Q4도 읽지만 이 expected에서 검증하지 않은 60건은 `parsed`다.
최근 정의 버전은 해당 문서에만 적용하며 2016~2025 legacy 형식에 자동 확장하지 않는다.
PDF/IR 원문 대조는 이번 범위에 포함되지 않았다. 복수 출처 저장 테스트의 IR은 명시적 합성 fixture다.
