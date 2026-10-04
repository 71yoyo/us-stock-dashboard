import { STANDARD_RAW_METRICS } from './sec-standard-raw.js';
import { extractCompactRawRecords } from './sec-standard-raw-incremental.js';
import { validateStandardRawRecords } from './sec-standard-raw-store.js';

export const SEC_RAW_MESSAGE_VERSION = 1;
export const SEC_RAW_MESSAGE_MAX_BYTES = 64000;
export const RAW_ANCHOR_TAGS = ['Revenues','RevenueFromContractWithCustomerExcludingAssessedTax',
  'NetIncomeLoss','NetCashProvidedByUsedInOperatingActivities','InterestIncomeExpenseNet'];
export const compactTagUnits = new Map(RAW_ANCHOR_TAGS.map(tag => [`us-gaap:${tag}`,'USD']));
for (const metric of Object.values(STANDARD_RAW_METRICS)) for (const tag of metric.tags) {
  compactTagUnits.set(tag.includes(':') ? tag : `us-gaap:${tag}`,metric.unit);
}
const rowKeys = ['start','end','val','form','fp','fy','filed','accn','frame','entityScope'];
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value,allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));
const reject = () => { throw new Error('SEC_RAW_INVALID_PAYLOAD'); };

/** 순서가 의미 있는 fact 배열은 유지하고 객체 key만 정규화한다. 전송 시각/messageId는 identity에서 제외한다. */
export function canonicalRawSource(value) {
  if (Array.isArray(value)) return value.map(canonicalRawSource);
  return plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonicalRawSource(value[key])])) : value;
}
export async function rawSourceIdentity(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalRawSource(value)));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
    .map(byte => byte.toString(16).padStart(2,'0')).join('');
}
export const rawMessageSource = message => ({ version:message.version,ticker:message.ticker,
  accession:message.accession,filing:message.filing,facts:message.facts,financialPeriods:message.financialPeriods });

/** DB 접근 전 전체 envelope/fact/identity를 검증한다. 지원하지 않는 version은 silent fallback하지 않는다. */
export async function validateCompactSecRawMessage(input) {
  let message = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > SEC_RAW_MESSAGE_MAX_BYTES) reject();
    try { message = JSON.parse(input); } catch { reject(); }
  }
  if (!keys(message,['version','ticker','accession','filing','facts','financialPeriods','enqueuedAt','sourceIdentity','idempotencyKey'])) reject();
  if (message.version !== SEC_RAW_MESSAGE_VERSION) throw new Error('SEC_RAW_UNSUPPORTED_VERSION');
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(message.ticker || '')
    || !/^\d{10}-\d{2}-\d{6}$/.test(message.accession || '') || !date(message.enqueuedAt?.slice?.(0,10))
    || !Number.isFinite(Date.parse(message.enqueuedAt))) reject();
  if (!keys(message.filing,['provider','cik','accession']) || message.filing.provider !== 'SEC EDGAR'
    || !/^\d{1,10}$/.test(message.filing.cik || '') || message.filing.accession !== message.accession) reject();
  if (!keys(message.facts,['us-gaap','dei']) || !Array.isArray(message.financialPeriods)
    || message.financialPeriods.length > 100) reject();
  const periodKeys = new Set();
  for (const period of message.financialPeriods) {
    if (!keys(period,['period_type','fiscal_period_end']) || !['annual','quarterly'].includes(period.period_type)
      || !date(period.fiscal_period_end)) reject();
    const key = `${period.period_type}:${period.fiscal_period_end}`;
    if (periodKeys.has(key)) reject();
    periodKeys.add(key);
  }
  let count = 0;
  for (const [taxonomy,tags] of Object.entries(message.facts)) {
    if (!plain(tags)) reject();
    for (const [tag,fact] of Object.entries(tags)) {
      const unit = compactTagUnits.get(`${taxonomy}:${tag}`);
      if (!unit || !keys(fact,['units']) || !keys(fact.units,[unit]) || !Array.isArray(fact.units[unit])) reject();
      const identities = new Set();
      for (const row of fact.units[unit]) {
        if (!keys(row,rowKeys) || row.accn !== message.accession || !date(row.end) || !date(row.filed)
          || row.end > row.filed || !Number.isFinite(row.val)
          || !['10-K','10-K/A','10-Q','10-Q/A'].includes(row.form)
          || row.start !== undefined && (!date(row.start) || row.start > row.end)
          || row.fy !== undefined && !Number.isInteger(row.fy)
          || row.fp !== undefined && !['FY','Q1','Q2','Q3','Q4'].includes(row.fp)
          || row.frame !== undefined && !/^[A-Za-z0-9-]{1,40}$/.test(row.frame)
          || row.entityScope !== undefined && !['parent','consolidated'].includes(row.entityScope)) reject();
        const key = JSON.stringify(canonicalRawSource(row));
        if (identities.has(key)) reject();
        identities.add(key);count++;
      }
    }
  }
  if (!count || count > 2000 || new TextEncoder().encode(JSON.stringify(message)).length > SEC_RAW_MESSAGE_MAX_BYTES) reject();
  const sourceIdentity = await rawSourceIdentity(rawMessageSource(message));
  if (message.sourceIdentity !== sourceIdentity || message.idempotencyKey !== `sec-raw:${sourceIdentity}`) reject();
  const records = extractCompactRawRecords(message.facts,message.accession,message.financialPeriods);
  validateStandardRawRecords(records);
  return { message,records };
}
