import { createBoundedJsonClient } from './sec-raw-production-http.mjs';
import { safeError } from './sec-raw-automation-policy.mjs';

const tables=new Set(['companies','sec_raw_payload_checkpoint','sec_raw_runtime','financial_metrics','d1_migrations']);
/** producer에 필요한 작은 SELECT만 허용한다. 주석·복문·PRAGMA·전체 raw/provenance scan은 거부한다. */
export function assertProducerReadSql(sql) {
  if (typeof sql!=='string' || sql.length>6000 || !/^\s*SELECT\b/i.test(sql) || /;|--|\/\*|\*\//.test(sql)) throw safeError('D1_READ');
  const tokens=sql.replace(/'(?:''|[^'])*'/g,"''");
  if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|LOAD_EXTENSION)\b/i.test(tokens) ||
      /["`\[\]]/.test(tokens)) throw safeError('D1_READ');
  const names=[...tokens.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map(match=>match[1].toLowerCase());
  if (names.some(name=>!tables.has(name))) throw safeError('D1_READ');
  if (names.some(name=>name!=='d1_migrations') && (!/\bWHERE\b/i.test(tokens) || !/\?/.test(tokens))) throw safeError('D1_READ');
  return sql;
}

/** D1 Read 전용이다. 승인 account URL + metadata UUID/name으로 identity를 구성하며 fallback은 없다. */
export function createProductionD1Adapter({fetchImpl,credential,target,maxQueries=301,timeoutMs=10000}={}) {
  if (!/^[a-f0-9]{32}$/.test(target?.accountId??'') || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(target?.databaseId??'') ||
      !/^[a-z0-9][a-z0-9-]{2,62}$/.test(target?.databaseName??'') || !Number.isSafeInteger(maxQueries) || maxQueries<1 || maxQueries>301) throw safeError('POLICY_INVALID');
  const request=createBoundedJsonClient({fetchImpl,credential,timeoutMs,category:'D1_READ',
    base:`https://api.cloudflare.com/client/v4/accounts/${target.accountId}/d1/database/${target.databaseId}`});
  let verified=null,queries=0;
  async function identity() {
    if (verified) return verified;
    const {data}=await request('');
    if (data?.success!==true || data.result?.uuid!==target.databaseId || data.result?.name!==target.databaseName) throw safeError('TARGET_MISMATCH');
    verified=Object.freeze({uuid:data.result.uuid,name:data.result.name,accountId:target.accountId,
      databaseId:data.result.uuid,databaseName:data.result.name});return verified;
  }
  function prepare(sql) {
    assertProducerReadSql(sql);
    const statement=params=>Object.freeze({bind:(...values)=>{
      if (values.length>100 || values.some(value=>!(value===null || typeof value==='string' || typeof value==='number' && Number.isFinite(value)))) throw safeError('D1_READ');
      return statement(values);
    },all:async()=>{
      await identity();if (++queries>maxQueries) throw safeError('D1_READ');
      const {data}=await request('/query',{method:'POST',body:{sql,params}});
      const result=data?.result?.[0];
      if (data?.success!==true || !Array.isArray(data.result) || data.result.length!==1 || result?.success!==true ||
          !Array.isArray(result.results) || result.results.length>100 || result.meta?.rows_written>0) throw safeError('D1_READ');
      return {results:result.results};
    },first:async()=>{const response=await statement(params).all();return response.results[0]??null;}});
    return statement([]);
  }
  return Object.freeze({identity,prepare,stats:()=>({queries}),readOnly:true});
}
