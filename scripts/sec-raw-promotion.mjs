import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extractStandardRawMetrics } from '../worker/src/sec-standard-raw.js';
import { latestRawAccession } from '../worker/src/sec-standard-raw-runtime.js';
import { validateStandardRawRecords } from '../worker/src/sec-standard-raw-store.js';
import { canonicalRawSource, rawSourceIdentity } from '../worker/src/sec-raw-message.js';

const fail = code => { throw new Error(`SEC_RAW_APPROVAL_${code}`); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, names) => object(value) && Object.keys(value).length === names.length
  && names.every(name => Object.hasOwn(value,name));
const hashValid = value => /^[a-f0-9]{64}$/.test(value || '');
const liveVerifications = new WeakMap();
// boolean 한 개로 target guard를 우회하지 못하도록 이 프로세스의 실제 verify 결과만 인정한다.
export const isVerifiedPromotionTarget = (receipt,target) => object(receipt)
  && liveVerifications.get(receipt) === promotionHash({databaseId:target?.databaseId,name:target?.name});
export const promotionHash = value => createHash('sha256').update(JSON.stringify(canonicalRawSource(value))).digest('hex');
export const sourceBytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
export const currentCheckpoint = () => execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
export function configuredProductionTargets() {
  return JSON.parse(readFileSync(new URL('../worker/wrangler.jsonc',import.meta.url),'utf8')).d1_databases
    .map(row => ({ databaseId:row.database_id,name:row.database_name }));
}
export const isProductionTarget = (target, targets = configuredProductionTargets()) => targets.some(row =>
  row.databaseId === target?.databaseId || row.name === target?.name);

/** 실제 승인 artifact는 저장하지 않는다. schema/예시는 가상의 identity만 사용한다. */
export function validatePromotionEnvelope(envelope, { checkpoint=currentCheckpoint(),now=Date.now() } = {}) {
  if (!exactKeys(envelope,['approvalVersion','datasetVersion','checkpoint','issuedAt','expiresAt','target',
    'tickers','sourceHashes','ciks','periodAnchorHashes','historicalSourceIdentities','historicalAccessions',
    'expected','retentionExpected','minimumMigration','writeBudget','queue'])) fail('SCHEMA');
  if (envelope.approvalVersion !== 1 || !/^[A-Za-z0-9._-]{1,80}$/.test(envelope.datasetVersion)
    || !/^[a-f0-9]{40}$/.test(envelope.checkpoint) || envelope.checkpoint !== checkpoint) fail('CHECKPOINT');
  const issued = Date.parse(envelope.issuedAt), expires = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now
    || expires <= issued || expires-issued > 7*86400000) fail('EXPIRED');
  if (!exactKeys(envelope.target,['databaseId','name'])
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(envelope.target.databaseId)
    || !/^[a-zA-Z0-9_-]{1,80}$/.test(envelope.target.name)) fail('TARGET');
  const tickers = envelope.tickers;
  if (!Array.isArray(tickers) || !tickers.length || tickers.length > 100
    || new Set(tickers).size !== tickers.length || tickers.some(ticker => !/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker))) fail('SCOPE');
  for (const field of ['sourceHashes','ciks','periodAnchorHashes','historicalSourceIdentities','historicalAccessions']) {
    if (!exactKeys(envelope[field],tickers)) fail('ALLOWLIST');
    for (const ticker of tickers) if (field === 'ciks'
      ? !/^\d{1,10}$/.test(envelope[field][ticker]) : field === 'historicalAccessions'
        ? !/^\d{10}-\d{2}-\d{6}$/.test(envelope[field][ticker]) : !hashValid(envelope[field][ticker])) fail('ALLOWLIST');
  }
  if (!exactKeys(envelope.expected,['raw','provenance','missing','needsReview'])
    || Object.values(envelope.expected).some(value => !Number.isSafeInteger(value) || value < 0)
    || envelope.expected.raw < 1
    || envelope.expected.raw !== envelope.expected.provenance + envelope.expected.missing + envelope.expected.needsReview) fail('COUNTS');
  if (!exactKeys(envelope.retentionExpected,['recovered','total'])
    || !Number.isSafeInteger(envelope.retentionExpected.total) || envelope.retentionExpected.total < 0
    || envelope.retentionExpected.recovered !== envelope.retentionExpected.total) fail('RETENTION');
  if (!Number.isInteger(envelope.minimumMigration) || envelope.minimumMigration < 22
    || !Number.isSafeInteger(envelope.writeBudget) || envelope.writeBudget < estimateHistoricalWrites(envelope.expected)) fail('BUDGET');
  if (!exactKeys(envelope.queue,['accountId','queueId','name']) || !/^[a-f0-9]{32}$/.test(envelope.queue.accountId)
    || !/^[a-f0-9]{32}$/.test(envelope.queue.queueId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(envelope.queue.name)) fail('QUEUE');
  return envelope;
}

// 과금 실측이 아닌 사전 예상이다. 실행 시 실제 D1 meta와 일일 headroom gate는 별도로 필요하다.
export const estimateHistoricalWrites = counts => (counts.raw + counts.provenance)*3 + 2000;

/** 호출자가 write 가능한 adapter를 주더라도 verify-only는 SELECT만 허용한다. */
export function readOnlyDatabase(DB) {
  return { identity:() => DB.identity(),prepare(sql) {
    if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) fail('READ_ONLY');
    const wrap = statement => ({ bind:(...values) => wrap(statement.bind(...values)),
      all:() => statement.all(),first:() => statement.first(),run:() => fail('READ_ONLY') });
    return wrap(DB.prepare(sql));
  },batch:() => fail('READ_ONLY') };
}

/** 모든 종목을 읽고 검증한 뒤에야 apply를 허용한다. 중간 scope/hash 오류가 앞 종목 write로 이어지지 않는다. */
export async function verifyHistoricalPromotion({ DB,target,tickers,loadCompanyFacts,envelope,
  checkpoint=currentCheckpoint(),now=Date.now() }) {
  validatePromotionEnvelope(envelope,{checkpoint,now});
  if (promotionHash(target && {databaseId:target.databaseId,name:target.name}) !== promotionHash(envelope.target)
    || promotionHash(tickers) !== promotionHash(envelope.tickers)) fail('TARGET_SCOPE');
  const read = readOnlyDatabase(DB), identity = await read.identity();
  if ((identity.uuid || identity.id) !== envelope.target.databaseId || identity.name !== envelope.target.name) fail('IDENTITY');
  const migrations = (await read.prepare('SELECT name FROM d1_migrations ORDER BY name').all()).results;
  for (let number=1;number<=envelope.minimumMigration;number++) {
    if (!migrations.some(row => row.name.startsWith(`${String(number).padStart(4,'0')}_`))) fail('MIGRATIONS');
  }
  const tables = (await read.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map(row=>row.name);
  for (const table of ['sec_standard_raw_metrics','sec_standard_raw_provenance','sec_raw_runtime','sec_raw_runtime_guard','sec_raw_payload_checkpoint']) {
    if (!tables.includes(table)) fail('SCHEMA_MIGRATION');
  }
  const prepared = new Map(), observations = [];
  const counts = {raw:0,provenance:0,missing:0,needsReview:0};
  for (const ticker of tickers) {
    const company = await read.prepare('SELECT cik FROM companies WHERE ticker=?').bind(ticker).first();
    const input = await loadCompanyFacts(ticker);
    if (!company || !company.cik || Number(company.cik) !== Number(envelope.ciks[ticker])
      || Number(input.companyFacts?.cik) !== Number(company.cik)) fail('CIK');
    // loader가 제공한 hash 주장만 믿지 않고 실제 읽은 원문 bytes를 직접 해시한다.
    if (!(typeof input.sourceBytes === 'string' || input.sourceBytes instanceof Uint8Array)
      || sourceBytesHash(input.sourceBytes) !== envelope.sourceHashes[ticker]
      || promotionHash(JSON.parse(Buffer.from(input.sourceBytes).toString('utf8'))) !== promotionHash(input.companyFacts)) fail('SOURCE_HASH');
    const financialPeriods = (await read.prepare(`SELECT period_type,fiscal_period_end FROM financial_metrics
      WHERE ticker=? AND source='SEC EDGAR' ORDER BY period_type,fiscal_period_end`).bind(ticker).all()).results.map(row=>({...row}));
    if (!financialPeriods.length || promotionHash(financialPeriods) !== envelope.periodAnchorHashes[ticker]) fail('ANCHORS');
    const accession = latestRawAccession(input.companyFacts.facts);
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession || '')) fail('ACCESSION');
    const records = extractStandardRawMetrics(input.companyFacts.facts,{financialPeriods});
    validateStandardRawRecords(records);
    const sourceIdentity = await rawSourceIdentity({version:1,ticker,accession,cik:String(input.companyFacts.cik),facts:input.companyFacts.facts,financialPeriods});
    if (sourceIdentity !== envelope.historicalSourceIdentities[ticker]
      || accession !== envelope.historicalAccessions[ticker]) fail('SOURCE_IDENTITY');
    counts.raw += records.length;
    counts.provenance += records.filter(row=>row.provenance).length;
    counts.missing += records.filter(row=>row.availability === 'missing').length;
    counts.needsReview += records.filter(row=>row.availability === 'needs_review').length;
    const rawState = (await read.prepare('SELECT * FROM sec_raw_runtime WHERE ticker=?').bind(ticker).all()).results;
    const checkpoints = (await read.prepare('SELECT * FROM sec_raw_payload_checkpoint WHERE ticker=? ORDER BY channel').bind(ticker).all()).results;
    const existing = await read.prepare(`SELECT COUNT(*) AS raw_count,
      (SELECT COUNT(*) FROM sec_standard_raw_provenance WHERE ticker=?) AS provenance_count
      FROM sec_standard_raw_metrics WHERE ticker=?`).bind(ticker,ticker).first();
    const existingValues = (await read.prepare(`SELECT * FROM sec_standard_raw_metrics WHERE ticker=?
      ORDER BY metric_name,period_type,period_start,period_end`).bind(ticker).all()).results;
    const existingSources = (await read.prepare(`SELECT * FROM sec_standard_raw_provenance WHERE ticker=?
      ORDER BY metric_name,period_type,period_start,period_end,source_fingerprint`).bind(ticker).all()).results;
    observations.push({ticker,accession,sourceIdentity,recordsHash:promotionHash(records),existing,rawState,checkpoints,
      existingValuesHash:promotionHash(existingValues),existingSourcesHash:promotionHash(existingSources)});
    // caller의 mutable object를 재사용하지 않는다. bytes와 그 파싱 결과를 내부 사본으로 고정한다.
    const sourceBytes = Buffer.from(input.sourceBytes);
    prepared.set(ticker,{companyFacts:JSON.parse(sourceBytes.toString('utf8')),sourceBytes,financialPeriods});
  }
  if (promotionHash(counts) !== promotionHash(envelope.expected)) fail('EXPECTED');
  const receipt = {version:1,mode:'verify-only',status:'PASS',rowsWritten:0,checkpoint,
    manifestHash:promotionHash(envelope),datasetHash:promotionHash(observations),issuedAt:new Date(now).toISOString()};
  liveVerifications.set(receipt,promotionHash(envelope.target));
  return {mode:'verify-only',counts,estimatedWrites:estimateHistoricalWrites(counts),receipt,observations,prepared};
}

/** evidence는 신뢰 서명 대신 명시적 관리자 승인 입력이다. 현재 대상/원문/DB 상태와 즉시 재대조한다. */
export function requirePromotionEvidence(evidence, receipt, {now=Date.now()} = {}) {
  for (const mode of ['dry-run','verify-only']) {
    const item = evidence?.[mode];
    if (!exactKeys(item,['version','mode','status','rowsWritten','checkpoint','manifestHash','datasetHash','issuedAt'])
      || item.version !== 1 || item.mode !== mode || item.status !== 'PASS' || item.rowsWritten !== 0
      || item.checkpoint !== receipt.checkpoint || item.manifestHash !== receipt.manifestHash
      || item.datasetHash !== receipt.datasetHash || !Number.isFinite(Date.parse(item.issuedAt))
      || Date.parse(item.issuedAt)>now || now-Date.parse(item.issuedAt)>3600000) fail('EVIDENCE');
  }
}

/** historical 승인 scope 전체가 동일 source로 원자 처리된 뒤에만 enqueue 가능하다. review pending은 허용한다. */
export async function assertHistoricalScopeProcessed(DB,envelope) {
  for (const ticker of envelope.tickers) {
    const row = await DB.prepare(`SELECT p.accession,p.source_identity,r.raw_status,r.raw_data_version,r.record_count
      FROM sec_raw_payload_checkpoint p JOIN sec_raw_runtime r ON r.ticker=p.ticker
      WHERE p.ticker=? AND p.channel='historical' AND p.schema_version=1`).bind(ticker).first();
    if (!row || !['ready','pending'].includes(row.raw_status) || row.raw_data_version !== 2 || row.record_count <= 0) fail('HISTORY_NOT_PROCESSED');
    if (row.source_identity !== envelope.historicalSourceIdentities[ticker]
      || row.accession !== envelope.historicalAccessions[ticker]) fail('HISTORY_IDENTITY');
    const integrity = await DB.prepare(`SELECT COUNT(*) AS actual_count,
      SUM(CASE WHEN m.availability='available' AND p.source_fingerprint IS NULL THEN 1 ELSE 0 END) AS source_gaps
      FROM sec_standard_raw_metrics m LEFT JOIN sec_standard_raw_provenance p
      ON p.ticker=m.ticker AND p.metric_name=m.metric_name AND p.period_type=m.period_type
      AND p.period_start=m.period_start AND p.period_end=m.period_end AND p.source_fingerprint=m.source_fingerprint
      WHERE m.ticker=?`).bind(ticker).first();
    if (integrity.actual_count < row.record_count || integrity.source_gaps !== 0) fail('HISTORY_INTEGRITY');
  }
}
