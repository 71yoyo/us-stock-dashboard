import { createHash } from 'node:crypto';

/** 외부 오류 원문을 넘기지 않는다. 공개 가능한 범주는 이 파일의 고정 코드뿐이다. */
export const errorCategories = new Set(['POLICY_INVALID','RELEASE_MISMATCH','TARGET_MISMATCH','SCOPE_MISMATCH',
  'POLICY_TIME','BUDGET_EXHAUSTED','FETCH_BUDGET','SEC_FORBIDDEN','SEC_HTTP','SEC_NETWORK','SEC_TIMEOUT',
  'SEC_ABORTED','SOURCE_INVALID','SOURCE_TOO_LARGE','SOURCE_NOT_INDEXED','DISCOVERY_WINDOW_INCOMPLETE',
  'READINESS_INVALID','RECEIPT_INVALID','D1_READ','STATE_INVALID','JOURNAL_CAS','JOURNAL_IO','LOCK_BUSY','LOCK_STALE',
  'OPERATOR_REQUIRED','QUEUE_AUTH','QUEUE_TARGET','QUEUE_REJECTED','QUEUE_AMBIGUOUS','MESSAGE_INVALID','INTERNAL_SAFE']);
export function safeError(code) {
  const error = new Error(errorCategories.has(code) ? code : 'INTERNAL_SAFE');
  error.code = error.message;
  return error;
}
export function errorCategory(error) { return errorCategories.has(error?.code) ? error.code : 'INTERNAL_SAFE'; }
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function hash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
export function normalizeCik(value) {
  const text = String(value ?? '');
  if (!/^\d{1,10}$/.test(text) || Number(text) === 0) throw safeError('SCOPE_MISMATCH');
  return text.padStart(10,'0');
}
export function assertSymbol(symbol) {
  if (typeof symbol !== 'string' || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) || symbol === 'LMT') throw safeError('SCOPE_MISMATCH');
}
export const supportedForms = Object.freeze(['10-K','10-Q','10-K/A','10-Q/A']);
const fields = ['policyVersion','release','target','schemaVersion','scope','allowedForms','maxPayloadBytes',
  'maxPublishesPerRun','maxPublishesPerDay','maxFetchAttempts','maxProviderRequests','validFrom','expiresAt',
  'secFetchEnabled','productionEnqueueEnabled','policyManifestHash'];
const targetFields = ['accountId','databaseId','databaseName','queueId','queueName'];
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}
export function policyManifestHash(policy) {
  const { policyManifestHash: omitted, ...manifest } = policy;
  return hash(manifest);
}
/** Historical 승인서와 별개인 자동화 전용 allowlist다. 승인값을 자동 생성하거나 보정하지 않는다. */
export function validateAutomationPolicy(input, {release,target,now=Date.now()} = {}) {
  if (!exactKeys(input,fields) || !exactKeys(input.target,targetFields) || input.policyVersion !== 1 || input.schemaVersion !== 1 ||
      !/^[a-f0-9]{40}$/.test(input.release ?? '') || !/^[a-f0-9]{64}$/.test(input.policyManifestHash ?? '') ||
      input.policyManifestHash !== policyManifestHash(input)) throw safeError('POLICY_INVALID');
  if (input.release !== release) throw safeError('RELEASE_MISMATCH');
  const t = input.target;
  if (!/^[a-f0-9]{32}$/.test(t.accountId ?? '') || !/^[a-f0-9]{32}$/.test(t.queueId ?? '') ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(t.databaseId ?? '') ||
      !/^[a-z0-9][a-z0-9-]{2,62}$/.test(t.databaseName ?? '') || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(t.queueName ?? '') ||
      canonical(t) !== canonical(target)) throw safeError('TARGET_MISMATCH');
  if (!Array.isArray(input.scope) || !input.scope.length || input.scope.length > 100) throw safeError('SCOPE_MISMATCH');
  const symbols = new Set();
  for (const row of input.scope) {
    if (!exactKeys(row,['ticker','cik'])) throw safeError('SCOPE_MISMATCH');
    assertSymbol(row.ticker); normalizeCik(row.cik);
    if (symbols.has(row.ticker)) throw safeError('SCOPE_MISMATCH');
    symbols.add(row.ticker);
  }
  if (!Array.isArray(input.allowedForms) || !input.allowedForms.length || new Set(input.allowedForms).size !== input.allowedForms.length ||
      input.allowedForms.some(f=>!supportedForms.includes(f))) throw safeError('POLICY_INVALID');
  for (const key of ['maxPublishesPerRun','maxPublishesPerDay','maxFetchAttempts','maxProviderRequests','maxPayloadBytes']) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 1) throw safeError('POLICY_INVALID');
  }
  if (input.maxPublishesPerRun > 100 || input.maxPublishesPerDay > 1000 || input.maxPayloadBytes > 64000 ||
      input.maxFetchAttempts > 300 || input.maxProviderRequests > 300 || input.maxPublishesPerRun > input.maxPublishesPerDay ||
      typeof input.secFetchEnabled !== 'boolean' || typeof input.productionEnqueueEnabled !== 'boolean') throw safeError('POLICY_INVALID');
  const from = Date.parse(input.validFrom), until = Date.parse(input.expiresAt);
  if (!Number.isFinite(from) || !Number.isFinite(until) || !Number.isFinite(now) || from > now || until <= now ||
      until <= from || until - from > 7*86400000) throw safeError('POLICY_TIME');
  return deepFreeze(structuredClone(input));
}
export function assertPolicyCurrent(policy, now) {
  if (now < Date.parse(policy.validFrom) || now >= Date.parse(policy.expiresAt)) throw safeError('POLICY_TIME');
}
export function assertPolicyMessage(policy,message) {
  const approved = policy.scope.find(row=>row.ticker === message?.ticker);
  if (!approved || normalizeCik(approved.cik) !== normalizeCik(message?.filing?.cik)) throw safeError('SCOPE_MISMATCH');
  if (Buffer.byteLength(JSON.stringify(message)) > policy.maxPayloadBytes) throw safeError('MESSAGE_INVALID');
  for (const tags of Object.values(message.facts ?? {})) for (const tag of Object.values(tags))
    for (const rows of Object.values(tag.units ?? {})) if (rows.some(row=>!policy.allowedForms.includes(row.form))) throw safeError('MESSAGE_INVALID');
}
