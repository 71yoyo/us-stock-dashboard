import { canonical, hash, normalizeCik, deepFreeze, safeError, assertPolicyCurrent, producerIdentityAlgorithmVersion } from './sec-raw-automation-policy.mjs';
const receipts = new WeakSet();

/** 일상 run에서 raw/provenance 전체 scan 대신 scope-sized LEFT JOIN 한 번만 사용한다. identity adapter는 read-only여야 한다. */
export function createD1ProducerReader(DB) {
  return Object.freeze({
    identity:()=>DB.identity(),
    readiness:async scope=>{
      const placeholders=scope.map(()=>'?').join(',');
      const response=await DB.prepare(`SELECT c.ticker,c.cik,h.accession AS historical_accession,
        h.source_identity AS historical_source_identity,h.schema_version AS historical_schema_version,
        r.raw_schema_version,r.raw_data_version,r.raw_status,r.record_count,r.available_count,
        (SELECT MAX(CAST(substr(name,1,4) AS INTEGER)) FROM d1_migrations) AS migration
        FROM companies c LEFT JOIN sec_raw_payload_checkpoint h ON h.ticker=c.ticker AND h.channel='historical'
        LEFT JOIN sec_raw_runtime r ON r.ticker=c.ticker WHERE c.ticker IN (${placeholders})`).bind(...scope.map(row=>row.ticker)).all();
      return response.results;
    },
    ticker:async ticker=>{
      try {
      const checkpoint=await DB.prepare(`SELECT accession,source_identity,schema_version FROM sec_raw_payload_checkpoint
        WHERE ticker=? AND channel='compact'`).bind(ticker).first();
      const runtime=await DB.prepare(`SELECT raw_status,raw_last_accession,attempt_accession,raw_schema_version,raw_data_version
        FROM sec_raw_runtime WHERE ticker=?`).bind(ticker).first();
      const periods=await DB.prepare(`SELECT period_type,fiscal_period_end FROM
        (SELECT period_type,fiscal_period_end FROM financial_metrics WHERE ticker=? AND source='SEC EDGAR' AND period_type='annual'
         ORDER BY fiscal_period_end DESC LIMIT 10)
        UNION ALL SELECT period_type,fiscal_period_end FROM
        (SELECT period_type,fiscal_period_end FROM financial_metrics WHERE ticker=? AND source='SEC EDGAR' AND period_type='quarterly'
         ORDER BY fiscal_period_end DESC LIMIT 40)
        ORDER BY period_type,fiscal_period_end`).bind(ticker,ticker).all();
      return {checkpoint:checkpoint?{accession:checkpoint.accession,sourceIdentity:checkpoint.source_identity,schemaVersion:checkpoint.schema_version}:null,
        runtime,financialPeriods:periods.results};
      } catch {throw safeError('D1_READ');}
    }
  });
}
export async function establishReadiness({policy,reader,runId,now=Date.now,ttlMs=300000}) {
  assertPolicyCurrent(policy,now());
  const identity=await reader.identity();
  if (identity?.uuid!==policy.target.databaseId || identity?.name!==policy.target.databaseName || identity?.accountId!==policy.target.accountId) throw safeError('TARGET_MISMATCH');
  const rows=await reader.readiness(policy.scope);
  if (!Array.isArray(rows) || rows.length!==policy.scope.length || new Set(rows.map(row=>row.ticker)).size!==rows.length) throw safeError('READINESS_INVALID');
  const historical={};
  for (const approved of policy.scope) {
    const row=rows.find(r=>r.ticker===approved.ticker);
    if (!row || normalizeCik(row.cik)!==normalizeCik(approved.cik) || row.migration<22 || row.historical_schema_version!==1 ||
        !/^\d{10}-\d{2}-\d{6}$/.test(row.historical_accession ?? '') || !/^[a-f0-9]{64}$/.test(row.historical_source_identity ?? '') ||
        row.raw_schema_version!==1 || row.raw_data_version!==2 || !Number.isSafeInteger(row.record_count) || row.record_count<1 ||
        !Number.isSafeInteger(row.available_count) || row.available_count<1 || row.available_count>row.record_count ||
        !['ready','pending'].includes(row.raw_status)) throw safeError('READINESS_INVALID');
    historical[row.ticker]={accession:row.historical_accession,sourceIdentity:row.historical_source_identity};
  }
  const time=now();
  const receipt=deepFreeze({runId,policyHash:policy.policyManifestHash,release:policy.release,scopeHash:hash(policy.scope),target:structuredClone(policy.target),
    identityAlgorithmVersion:producerIdentityAlgorithmVersion(policy),
    verifiedAt:new Date(time).toISOString(),expiresAt:new Date(Math.min(time+ttlMs,Date.parse(policy.expiresAt))).toISOString(),historical});
  receipts.add(receipt); return receipt;
}
export function assertReadiness(receipt,policy,runId,now=Date.now()) {
  assertPolicyCurrent(policy,now);
  if (!receipts.has(receipt) || receipt.identityAlgorithmVersion!==producerIdentityAlgorithmVersion(policy) ||
      receipt.runId!==runId || receipt.policyHash!==policy.policyManifestHash || receipt.release!==policy.release ||
      receipt.scopeHash!==hash(policy.scope) || canonical(receipt.target)!==canonical(policy.target) || now<Date.parse(receipt.verifiedAt) || now>=Date.parse(receipt.expiresAt)) throw safeError('RECEIPT_INVALID');
}
