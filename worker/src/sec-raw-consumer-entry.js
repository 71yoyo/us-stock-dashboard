import { handleSecRawQueue } from './sec-raw-queue.js';

// 별도 Worker 전용 진입점이다. fetch/scheduled/앱 router/Cron은 의도적으로 제공하지 않는다.
export default {
  async queue(batch, environment) {
    return handleSecRawQueue(batch, { DB:environment.DB,
      SEC_STANDARD_RAW_QUEUE_ENABLED:environment.SEC_STANDARD_RAW_QUEUE_ENABLED,
      // queue enable과 독립된 명시적 opt-in이다. unset/false는 wrapper와 추가 console output 모두 0이다.
      SEC_STANDARD_RAW_TELEMETRY_ENABLED:environment.SEC_STANDARD_RAW_TELEMETRY_ENABLED }, { queueOnly:true });
  }
};
