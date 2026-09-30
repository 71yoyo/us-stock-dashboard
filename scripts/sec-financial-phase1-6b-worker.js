import { createSecFinancialRolloutWorker } from './sec-financial-rollout-worker.js';

// 공개 운영 배포가 아닌 원격 검증 세션에서 승인된 나머지 5종목만 처리한다.
const rollout = createSecFinancialRolloutWorker(['ABBV', 'ABT', 'AMZN', 'GOOGL', 'TSLA']);
const response = (status, body) => new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default {
  async fetch(request, environment) {
    // 운영 설정을 상속해 실제 manual 상태를 확인한다. 설정 변경이나 자동 큐 호출은 하지 않는다.
    if (environment.SEC_FINANCIAL_ROLLOUT_MODE !== 'manual') {
      return response(503, { blocker: 'ROLLOUT MODE BLOCKER', databaseWrite: false });
    }
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/sec-rollout-mode') {
      return response(200, { rolloutMode: 'manual', databaseWrite: false });
    }
    // Phase 1.6B는 승인된 종목별 POST만 사용한다. 사전 확인용 NVDA 재조회도 열지 않는다.
    if (request.method !== 'POST') return response(404, { error: '허용된 단일 종목 처리만 가능합니다.' });
    return rollout.fetch(request, environment);
  }
};
