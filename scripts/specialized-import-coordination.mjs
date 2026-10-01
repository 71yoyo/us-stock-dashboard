const nowSql = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
export const DEFAULT_LEASE_MS = 120000;

// DB 시각만 사용한다. takeover마다 fence를 증가시키며 active other owner는 변경하지 않는다.
export async function acquireLease(DB, datasetKey, owner, ttl = DEFAULT_LEASE_MS) {
  if (!datasetKey || !owner || !Number.isInteger(ttl) || ttl < 1 || ttl > 300000) throw new Error('lease 입력 오류');
  return DB.prepare(`INSERT INTO specialized_import_lease(lock_key,dataset_key,owner_token,fence,expires_ms)
    VALUES('specialized',?,?,1,${nowSql}+?) ON CONFLICT(lock_key) DO UPDATE SET
    dataset_key=excluded.dataset_key,owner_token=excluded.owner_token,fence=specialized_import_lease.fence+1,
    expires_ms=excluded.expires_ms WHERE specialized_import_lease.expires_ms<=${nowSql}
    RETURNING dataset_key,owner_token,fence,expires_ms`).bind(datasetKey, owner, ttl).first();
}
export async function renewLease(DB, lease, ttl = DEFAULT_LEASE_MS) {
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 300000) throw new Error('lease TTL 오류');
  const row = await DB.prepare(`UPDATE specialized_import_lease SET expires_ms=${nowSql}+?
    WHERE lock_key='specialized' AND dataset_key=? AND owner_token=? AND fence=? AND expires_ms>${nowSql}
    RETURNING dataset_key,owner_token,fence,expires_ms`)
    .bind(ttl, lease.dataset_key, lease.owner_token, lease.fence).first();
  if (!row) throw new Error('lease ownership 상실');
  return row;
}
export async function releaseLease(DB, lease) {
  return DB.prepare(`UPDATE specialized_import_lease SET expires_ms=0 WHERE lock_key='specialized'
    AND dataset_key=? AND owner_token=? AND fence=? RETURNING fence`)
    .bind(lease.dataset_key, lease.owner_token, lease.fence).first();
}
export function fenceStatement(DB, lease) {
  return DB.prepare(`INSERT INTO specialized_import_guard(id,ok) VALUES(1,CASE WHEN EXISTS
    (SELECT 1 FROM specialized_import_lease WHERE lock_key='specialized' AND dataset_key=?
    AND owner_token=? AND fence=? AND expires_ms>${nowSql}) THEN 1 ELSE 0 END)
    ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`).bind(lease.dataset_key, lease.owner_token, lease.fence);
}
// 모든 문서 transaction 앞/뒤에 fence를 검사한다. preflight 통과 후 ownership 상실도 rollback된다.
export function fencedDatabase(DB, lease) {
  return { prepare: DB.prepare.bind(DB), batch: statements => DB.batch([
    fenceStatement(DB, lease), ...statements, fenceStatement(DB, lease)
  ]) };
}
