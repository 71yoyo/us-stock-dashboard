/**
 * Pages 화면이 호출할 Worker API 주소를 한 곳에서 관리한다.
 * Worker를 처음 배포한 뒤 발급된 workers.dev 주소를 apiBaseUrl에 입력해 GitHub에 반영한다.
 * 빈 문자열이면 외부 API를 호출하지 않고 기존 화면의 예시·로컬 데이터만 유지한다.
 */
window.US_STOCK_PRO_CONFIG = Object.freeze({
  apiBaseUrl: ''
});
