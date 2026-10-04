import { compactTagUnits, rawSourceIdentity, rawMessageSource, validateCompactSecRawMessage } from '../worker/src/sec-raw-message.js';

/** Node에서 필요한 표준 fact만 선택한다. Worker는 전체 CompanyFacts를 받지 않는다. */
export function selectCompactRawFacts(facts, accession) {
  const compact = { 'us-gaap':{}, dei:{} };
  for (const [qualified,unit] of compactTagUnits) {
    const [taxonomy,tag] = qualified.split(':');
    const rows = facts?.[taxonomy]?.[tag]?.units?.[unit];
    if (!Array.isArray(rows)) continue;
    const selected = rows.filter(row => row.accn === accession && !row.segment && !row.dimensions)
      .map(row => Object.fromEntries(['start','end','val','form','fp','fy','filed','accn','frame','entityScope']
        .filter(key => row[key] !== undefined).map(key => [key,row[key]])));
    if (selected.length) compact[taxonomy][tag] = { units:{[unit]:selected} };
  }
  return compact;
}

/** 신규 공시 직접기간/비교기간/동일 accession 차감 입력/DEI 실제 날짜를 함께 보존한다. */
export async function buildCompactSecRawMessage({ ticker,accession,companyFacts,financialPeriods=[],enqueuedAt=new Date().toISOString() }) {
  const facts = selectCompactRawFacts(companyFacts?.facts,accession);
  const dates = new Set(Object.values(facts).flatMap(tags => Object.values(tags))
    .flatMap(fact => Object.values(fact.units)).flat().map(row => row.end));
  const message = { version:1,ticker,accession,filing:{provider:'SEC EDGAR',cik:String(companyFacts?.cik || ''),accession},facts,
    financialPeriods:financialPeriods.filter(row => dates.has(row.fiscal_period_end))
      .map(({period_type,fiscal_period_end}) => ({period_type,fiscal_period_end})),enqueuedAt };
  message.sourceIdentity = await rawSourceIdentity(rawMessageSource(message));
  message.idempotencyKey = `sec-raw:${message.sourceIdentity}`;
  await validateCompactSecRawMessage(message);
  return message;
}

/** 내부 accession event adapter다. production scheduler에 연결하지 않고 injectable Queue만 사용한다. */
export async function enqueueCompactSecRaw(message, { queue,enabled=false,dryRun=true } = {}) {
  await validateCompactSecRawMessage(message);
  if (!enabled || dryRun) return { status:'dry-run',idempotencyKey:message.idempotencyKey };
  if (typeof queue?.send !== 'function') throw new Error('SEC raw Queue binding을 지정해 주세요.');
  await queue.send(message,{contentType:'json'});
  // enqueue는 완료 checkpoint가 아니다. consumer가 ready/review 여부를 결정한다.
  return { status:'queued',idempotencyKey:message.idempotencyKey };
}

/** 향후 Node discovery/event 연결 지점이다. 기존 Worker Cron/2종목 guard에는 연결하지 않는다. */
export async function onSecRawAccessionDetected(event, options = {}) {
  const message = await buildCompactSecRawMessage(event);
  return enqueueCompactSecRaw(message, options);
}
