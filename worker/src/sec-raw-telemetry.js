// CPU는 Cloudflare invocation telemetry에서만 읽는다. 이 모듈은 시간 측정/추가 SQL 없이 D1 응답을 관찰한다.
export const rawTelemetryEnabled = environment => environment.SEC_STANDARD_RAW_TELEMETRY_ENABLED === 'true';

const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = value => numeric(value) && Number.isSafeInteger(value);
const metaFields = { rowsRead:'rows_read', rowsWritten:'rows_written', d1DurationMs:'duration' };
const operationKind = sql => {
  // SQL은 메모리에서 대상만 분류하고 보관하거나 출력하지 않는다. changes와 과금 rows_written은 별개다.
  if (/^\s*INSERT\s+INTO\s+sec_standard_raw_metrics\b/i.test(sql)) return 'rawDelta';
  if (/^\s*INSERT\s+INTO\s+sec_standard_raw_provenance\b/i.test(sql)) return 'provenanceDelta';
  if (/^\s*INSERT\s+INTO\s+sec_raw_payload_checkpoint\b/i.test(sql)) return 'checkpointChanges';
  return null;
};

/** 호출마다 새 collector를 만든다. 전역 상태/추가 SELECT/환경변수/credential 접근은 없다. */
export function createD1MetaCollector(database) {
  const totals = { d1Calls:0, sqlStatements:0, singleCalls:0, batchCalls:0,
    rowsRead:0, rowsWritten:0, d1DurationMs:0, rawDelta:0, provenanceDelta:0, checkpointChanges:0 };
  const complete = Object.fromEntries([...Object.keys(metaFields),'rawDelta','provenanceDelta','checkpointChanges'].map(k=>[k,true]));
  const statementInfo = new WeakMap();
  let metaResults = 0, failedCalls = 0, observationFailures = 0;
  const observe = (result, kind) => {
    // 어댑터가 meta를 생략하면 값은 null이다. 성공/no-op을 0으로 추측하지 않는다.
    const meta = result?.meta;
    if (meta && typeof meta === 'object') metaResults++;
    for (const [field,key] of Object.entries(metaFields)) {
      const value = meta?.[key];
      if ((field==='d1DurationMs'?numeric:integer)(value)) totals[field] += value;
      else complete[field] = false;
    }
    if (kind) {
      if (integer(meta?.changes)) totals[kind] += meta.changes;
      else complete[kind] = false;
    }
  };
  const uncertain = kinds => {
    failedCalls++;
    for (const field of Object.keys(metaFields)) complete[field] = false;
    for (const kind of kinds) if (kind) complete[kind] = false;
  };
  const observeSafely = (result,kind) => {
    try { observe(result,kind); }
    catch {
      // meta 읽기 자체가 실패해도 성공한 DB 결과를 실패로 바꾸지 않는다. 비용은 미확정으로 표시한다.
      observationFailures++;
      for (const field of Object.keys(metaFields)) complete[field]=false;
      if (kind) complete[kind]=false;
    }
  };
  const execute = async (statement, method, kind) => {
    totals.d1Calls++; totals.singleCalls++; totals.sqlStatements++;
    try {
      const result = await statement[method]();
      observeSafely(result,kind);
      return result;
    } catch (error) { uncertain([kind]); throw error; }
  };
  const wrap = (statement, kind) => {
    const proxy = new Proxy(statement,{ get(target,key) {
      if (key==='bind') return (...values)=>wrap(target.bind(...values),kind);
      if (key==='all' || key==='run') return ()=>execute(target,key,kind);
      if (key==='first') return async column => {
        // D1 first()는 meta를 숨긴다. 동일 SQL을 all()로 한 번만 실행한 뒤 공식 first 반환 규칙을 보존한다.
        const result = await execute(target,'all',kind);
        const row = result.results?.[0];
        if (!row) return null;
        if (column===undefined) return row;
        if (row[column]===undefined) throw new Error('D1_COLUMN_NOTFOUND: Column not found');
        return row[column];
      };
      const value = Reflect.get(target,key,target);
      return typeof value==='function'?value.bind(target):value;
    }});
    statementInfo.set(proxy,{ statement,kind });
    return proxy;
  };
  // DB 자체가 없을 때도 관찰 때문에 새 예외를 만들지 않는다. 기존 runtime의 safe-fail이 처리한다.
  const DB = database && typeof database==='object' ? new Proxy(database,{get(target,key) {
    if (key==='prepare') return sql=>wrap(target.prepare(sql),operationKind(sql));
    if (key==='batch') return async statements => {
      const items = statements.map(statement=>statementInfo.get(statement) || {statement,kind:null});
      totals.d1Calls++; totals.batchCalls++; totals.sqlStatements+=items.length;
      try {
        const results = await target.batch(items.map(item=>item.statement));
        for (let i=0;i<items.length;i++) observeSafely(results?.[i],items[i].kind);
        return results;
      } catch (error) { uncertain(items.map(item=>item.kind)); throw error; }
    };
    const value = Reflect.get(target,key,target);
    return typeof value==='function'?value.bind(target):value;
  }}) : database;
  return { DB, snapshot() {
    return { ...totals, ...Object.fromEntries(Object.keys(complete).map(field=>[field,complete[field]?totals[field]:null])),
      metaComplete:Object.values(complete).every(Boolean), metaResults, failedCalls, observationFailures,
      // 일부 성공 응답이 있어도 실패한 invocation 전체 비용은 확정할 수 없다.
      observedRowsRead:totals.rowsRead, observedRowsWritten:totals.rowsWritten, observedD1DurationMs:totals.d1DurationMs };
  } };
}

const statuses = new Set(['ready','unchanged','pending_review','disabled','rejected','deferred','error']);
const identity = payload => ({ ticker:payload.ticker, schemaVersion:payload.version,
  sourceIdentity:payload.sourceIdentity, applicationIdentity:payload.idempotencyKey });
const outcome = status => ['ready','unchanged'].includes(status)?'success'
  : status==='pending_review'?'review_pending':status==='rejected'?'rejected'
  : status==='disabled'?'disabled':status==='exception'?'exception':'retry_requested';
const checkpointAction = (status,changes) => changes===null?'not_confirmed'
  : changes>0?'written':status==='unchanged'?'unchanged'
  : status==='pending_review'?'not_written_review':'not_written';

/** Queue-only invocation 종료 때 allowlist summary 한 건만 출력한다. logger 장애는 processing/retry를 바꾸지 않는다. */
export async function observeSecRawQueue(batch, environment, consume, emit = summary=>console.log(summary)) {
  const collector = createD1MetaCollector(environment.DB), messages = [], results = [];
  let threw = false;
  try {
    for (const message of batch.messages) {
      const detail = { ticker:null, schemaVersion:null, sourceIdentity:null, applicationIdentity:null,
        deliveryAttempt:integer(message.attempts)&&message.attempts>0?message.attempts:null,
        retryRequested:false, runtimeResult:'exception', outcome:'exception' };
      // message id/attempts는 Queue가 제공한 필드만 읽는다. body의 유사 필드나 임의 trace ID는 사용하지 않는다.
      if (typeof message.id==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(message.id)) detail.messageId=message.id;
      messages.push(detail);
      const result = await consume(message,{...environment,DB:collector.DB},payload=>Object.assign(detail,identity(payload)));
      detail.runtimeResult=statuses.has(result.status)?result.status:'unknown';
      detail.outcome=outcome(detail.runtimeResult);detail.retryRequested=result.action==='retry';
      results.push(result);
    }
    return results;
  } catch (error) { threw=true; throw error; }
  finally {
    const meta=collector.snapshot(),single=messages.length===1?messages[0]:null;
    const status=threw?'exception':single?.runtimeResult??'batch';
    const summary={event:'sec_raw_queue_summary',summaryVersion:1,
      ticker:single?.ticker??null,schemaVersion:single?.schemaVersion??null,
      sourceIdentity:single?.sourceIdentity??null,applicationIdentity:single?.applicationIdentity??null,
      outcome:threw?'exception':single?.outcome??'batch',runtimeResult:status,
      deliveryAttempt:single?.deliveryAttempt??null,retryRequested:messages.some(m=>m.retryRequested),
      retryRequestCount:messages.filter(m=>m.retryRequested).length,
      attemptMeaning:'Queue delivery attempt; runtime attempt_count와 별개',
      ...meta,checkpointAction:checkpointAction(status,meta.checkpointChanges),messageCount:messages.length,
      ...(single?.messageId?{messageId:single.messageId}:{}),...(single?{}:{messages})};
    try { emit(summary); } catch { /* 로그 실패로 이미 실행한 ack/retry/DB 결과를 변경하지 않는다. */ }
  }
}
