import { validateCompactSecRawMessage } from './sec-raw-message.js';
import { runRawRecordRuntime } from './sec-standard-raw-incremental.js';

export const standardRawQueueEnabled = env => env.SEC_STANDARD_RAW_QUEUE_ENABLED === 'true'
  && env.SEC_STANDARD_RAW_FIELDS_ENABLED === 'true';

/** invalid/schema 오류는 ack로 폐기하고 고정 코드만 반환한다. 원문 메시지/서버 오류/credential은 로그에 남기지 않는다. */
export async function consumeCompactSecRaw(message, environment, { queueOnly = false } = {}) {
  const enabled = queueOnly ? environment.SEC_STANDARD_RAW_QUEUE_ENABLED === 'true' : standardRawQueueEnabled(environment);
  if (!enabled) {
    message.retry({delaySeconds:900});
    return { status:'disabled',action:'retry' };
  }
  let validated;
  try { validated = await validateCompactSecRawMessage(message.body); }
  catch (error) {
    message.ack();
    return { status:'rejected',action:'ack',code:error.message === 'SEC_RAW_UNSUPPORTED_VERSION'
      ? 'UNSUPPORTED_VERSION' : 'INVALID_PAYLOAD' };
  }
  const { message:payload,records } = validated;
  // Queue-only entry의 로컬 실행 환경에만 compact executor gate를 전달한다. 앱 env/config는 변경하지 않는다.
  const execution = queueOnly ? { DB:environment.DB,SEC_STANDARD_RAW_FIELDS_ENABLED:'true' } : environment;
  const result = await runRawRecordRuntime(execution,payload.ticker,payload.accession,async()=>records,
    { sourceIdentity:payload.sourceIdentity,channel:'compact',strictReview:true });
  if (['ready','unchanged','pending_review'].includes(result.status)) {
    message.ack();return { ...result,action:'ack' };
  }
  // claim contention 또는 transient D1 장애는 기존 성공 checkpoint를 유지하고 backoff 후 재시도한다.
  message.retry({delaySeconds:900});
  return { ...result,action:'retry',category:'RETRYABLE' };
}

/** 하나씩 실행해 임대 경쟁/메모리 증가를 제한한다. full-history extractor/Node importer는 호출하지 않는다. */
export async function handleSecRawQueue(batch, environment, options = {}) {
  const results = [];
  for (const message of batch.messages) results.push(await consumeCompactSecRaw(message,environment,options));
  return results;
}
