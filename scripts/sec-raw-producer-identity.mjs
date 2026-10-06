import { selectCompactRawFacts, buildCompactSecRawMessage } from './sec-raw-compact-producer.mjs';
import { canonical, safeError } from './sec-raw-automation-policy.mjs';
import { rawMessageSource, validateCompactSecRawMessage } from '../worker/src/sec-raw-message.js';

// source hash 알고리즘과 wire schema/journal key 알고리즘은 서로 다른 버전 축이다.
export const compactIdentityAlgorithms = Object.freeze({ legacySource:1,canonicalSource:2,wireSchema:1,
  consumerApplication:1,journalApplication:1 });

/** R10B의 기존 정렬 규칙을 그대로 보존한다. 배열 외 field/unit/period는 정규화하거나 삭제하지 않는다. */
export function orderedCompactSource(companyFacts,accession) {
  const facts=selectCompactRawFacts(companyFacts.facts,accession);
  for (const tags of Object.values(facts)) for (const tag of Object.values(tags)) for (const rows of Object.values(tag.units))
    rows.sort((a,b)=>canonical(a).localeCompare(canonical(b),'en'));
  return {cik:companyFacts.cik,facts};
}

/** V1은 원본 fact 배열 순서까지 hash에 포함하는 승인된 legacy producer 자체를 호출한다. */
export async function computeLegacyCompactSourceIdentityV1(input) {
  return (await buildCompactSecRawMessage(input)).sourceIdentity;
}

/** V2는 fact 배열 정렬을 선행할 뿐 consumer의 hash/validator/schema를 바꾸지 않는다. */
export async function computeCanonicalCompactSourceIdentityV2(input) {
  return (await buildCompactSecRawMessage({...input,companyFacts:orderedCompactSource(input.companyFacts,input.accession)})).sourceIdentity;
}

/** telemetry의 applicationIdentity는 wire idempotencyKey다. journal용 SHA-256 key와 혼용하지 않는다. */
export function consumerApplicationIdentityV1(sourceIdentity) {
  if (!/^[a-f0-9]{64}$/.test(sourceIdentity??'')) throw safeError('MESSAGE_INVALID');
  return `sec-raw:${sourceIdentity}`;
}

function sortedFacts(facts) {
  const copied=structuredClone(facts);
  for (const tags of Object.values(copied)) for (const tag of Object.values(tags)) for (const rows of Object.values(tag.units))
    rows.sort((a,b)=>canonical(a).localeCompare(canonical(b),'en'));
  return copied;
}

/** hash뿐 아니라 모든 compact field와 추출 records/출처를 직접 대조한다. 허용 차이는 fact 배열 순서뿐이다. */
export async function compactSemanticsExact(legacy,canonicalMessage) {
  const a=await validateCompactSecRawMessage(legacy),b=await validateCompactSecRawMessage(canonicalMessage);
  const envelope=message=>({...rawMessageSource(message),facts:sortedFacts(message.facts)});
  return canonical(envelope(a.message))===canonical(envelope(b.message)) && canonical(a.records)===canonical(b.records);
}

/** pure producer 판단이다. DB/journal에 완료를 쓰거나 historical identity를 compact hash로 대체하지 않는다. */
export async function classifyCompactCheckpoint({checkpoint,message,companyFacts,financialPeriods}) {
  if (!message) return {decision:'SOURCE_NOT_INDEXED',reason:'NO_COMPACT_FACTS'};
  await validateCompactSecRawMessage(message);
  if (!checkpoint || checkpoint.accession!==message.accession) return {decision:'NEW_SOURCE',reason:'NEW_ACCESSION'};
  if (checkpoint.schemaVersion===1 && checkpoint.sourceIdentity===message.sourceIdentity)
    return {decision:'UNCHANGED',reason:'EXACT_CANONICAL_CHECKPOINT'};
  const legacy=await buildCompactSecRawMessage({ticker:message.ticker,accession:message.accession,companyFacts,
    financialPeriods,enqueuedAt:message.enqueuedAt});
  const semanticEquality=await compactSemanticsExact(legacy,message);
  if (checkpoint.schemaVersion===1 && checkpoint.sourceIdentity===legacy.sourceIdentity && semanticEquality)
    return {decision:'UNCHANGED_COMPAT',reason:'EXACT_LEGACY_HASH_AND_SEMANTICS',legacyIdentity:legacy.sourceIdentity,semanticEquality};
  return {decision:'CORRECTION_CANDIDATE',reason:semanticEquality?'NO_COMPLETED_IDENTITY_MATCH':'SEMANTIC_MISMATCH',
    legacyIdentity:legacy.sourceIdentity,semanticEquality};
}

/** journal의 legacy 별칭도 원본 V1 hash와 exact semantics가 증명될 때만 조회한다. state 승격은 하지 않는다. */
export async function legacyJournalAlias(message,companyFacts,financialPeriods) {
  const legacy=await buildCompactSecRawMessage({ticker:message.ticker,accession:message.accession,companyFacts,
    financialPeriods,enqueuedAt:message.enqueuedAt});
  return await compactSemanticsExact(legacy,message)?{ticker:message.ticker,accession:message.accession,
    sourceIdentity:legacy.sourceIdentity,schemaVersion:1}:null;
}
