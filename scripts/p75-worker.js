import { saveSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { classificationStatement, setManualClassification } from '../worker/src/company-classification.js';
import { querySpecializedMetrics } from '../worker/src/specialized-metric-query.js';
import { verifyDocument } from './p75-document-verification.js';

const NAME = 'us-stock-dashboard-p75-rehearsal-20261001';
const ID = 'de3f265c-d6ec-4561-8a53-64effad66eb5';
const nowSql = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
const tables = ['company_metric_definitions', 'company_metric_values', 'company_metric_sources'];
const orders = ['metric_code,definition_owner,definition_version', 'record_key', 'record_key,source_url,source_hash'];

// 별도 private preview에만 쓰는 계측 래퍼다. SQL 수와 RPC 수, 실제 반환된 D1 meta를 구분한다.
export function measuredDatabase(raw, metrics, options = {}) {
  const absorb = result => {
    for (const row of Array.isArray(result) ? result : [result]) {
      metrics.rows_read += row?.meta?.rows_read || 0; metrics.rows_written += row?.meta?.rows_written || 0;
      metrics.d1_duration_ms += row?.meta?.duration || 0;
    }
    return result;
  };
  return {
    prepare(sql) {
      const statement = raw.prepare(sql);
      const wrap = inner => ({
        bind: (...values) => wrap(inner.bind(...values)), _raw: inner,
        async all() { metrics.sql++; metrics.rpc++; return absorb(await inner.all()); },
        async first() { metrics.sql++; metrics.rpc++; const result = absorb(await inner.all()); return result.results[0] || null; },
        async run() { metrics.sql++; metrics.rpc++; return absorb(await inner.run()); }
      });
      return wrap(statement);
    },
    async batch(statements) {
      let rawStatements = statements.map(statement => statement._raw);
      metrics.document_batch_statements = rawStatements.length;
      if (options.lease) {
        const { dataset, owner, fence } = options.lease;
        // transaction 시작과 끝에서 DB 시각으로 소유권을 검사한다. stale owner는 CHECK 실패로 전체 rollback된다.
        const guard = () => raw.prepare(`UPDATE p75_guard SET ok=CASE WHEN EXISTS
          (SELECT 1 FROM p75_leases WHERE lock_key='specialized' AND dataset=? AND owner=? AND fence=? AND expires_ms>${nowSql})
          THEN 1 ELSE 0 END WHERE id=1`).bind(dataset, owner, fence);
        rawStatements = [guard(), ...rawStatements, guard()];
      }
      if (options.injectFailure) rawStatements.push(raw.prepare('INSERT INTO p75_guard(id,ok) VALUES(2,0)'));
      metrics.sql += rawStatements.length; metrics.rpc++; metrics.batch_statements = rawStatements.length;
      const started = Date.now();
      try { return absorb(await raw.batch(rawStatements)); }
      finally { metrics.batch_wall_ms = Date.now() - started; }
    }
  };
}

async function counts(DB) {
  const results = [];
  for (const table of tables) results.push(await DB.prepare(`SELECT COUNT(*) count FROM ${table}`).first());
  return Object.fromEntries(['definitions', 'values', 'provenance'].map((key, index) => [key, results[index].count]));
}

export default {
  async fetch(request, environment) {
    const metrics = { sql: 0, rpc: 0, rows_read: 0, rows_written: 0, d1_duration_ms: 0, retry: 0 };
    const start = Date.now();
    try {
      if (environment.DB || environment.REHEARSAL_MARKER !== 'P75_DISPOSABLE_ONLY'
        || environment.CONFIRM_DISPOSABLE !== 'YES' || environment.REHEARSAL_DATABASE_ID !== ID) throw new Error('P7.5 SAFETY BLOCKER');
      const raw = environment.REHEARSAL_DB.withSession('first-primary');
      const DB = measuredDatabase(raw, metrics);
      const identity = await DB.prepare('SELECT name,id FROM p75_environment').first();
      if (identity?.id !== ID || identity?.name !== NAME) throw new Error('P7.5 DB identity mismatch');
      const input = request.method === 'POST' ? await request.json() : {};
      const path = new URL(request.url).pathname;
      let result;
      if (path === '/health') result = { disposable: true, remote: true };
      else if (path === '/classify') {
        if (input.companies) for (const company of input.companies) await DB.prepare(`INSERT INTO companies(ticker,name,cik,sector,industry)
          VALUES(?,?,?,?,?) ON CONFLICT(ticker) DO UPDATE SET sector=excluded.sector,industry=excluded.industry`)
          .bind(company.ticker, company.name, company.cik, company.sector, company.industry).run();
        if (input.override) await setManualClassification({ DB }, input.override.ticker, input.override.profile, 'P75 synthetic override');
        const companies = (await DB.prepare('SELECT ticker,name,cik,sector,industry FROM companies ORDER BY ticker').all()).results;
        await DB.batch(companies.map(company => classificationStatement(DB, company)));
        result = (await DB.prepare('SELECT * FROM company_classification ORDER BY ticker').all()).results;
      } else if (path === '/lease') {
        const { action, owner, dataset, fence, ttl = 60000 } = input;
        if (!owner || !dataset || ttl < 1 || ttl > 120000) throw new Error('lease 입력 오류');
        if (action === 'acquire') result = await DB.prepare(`INSERT INTO p75_leases(lock_key,dataset,owner,fence,expires_ms)
          VALUES('specialized',?,?,1,${nowSql}+?) ON CONFLICT(lock_key) DO UPDATE SET dataset=excluded.dataset,
          owner=excluded.owner,fence=p75_leases.fence+1,expires_ms=excluded.expires_ms
          WHERE p75_leases.expires_ms<=${nowSql} RETURNING dataset,owner,fence,expires_ms`).bind(dataset, owner, ttl).first();
        else if (action === 'renew') result = await DB.prepare(`UPDATE p75_leases SET expires_ms=${nowSql}+?
          WHERE lock_key='specialized' AND dataset=? AND owner=? AND fence=? AND expires_ms>${nowSql}
          RETURNING dataset,owner,fence,expires_ms`).bind(ttl, dataset, owner, fence).first();
        else if (action === 'release') result = await DB.prepare(`UPDATE p75_leases SET expires_ms=0
          WHERE lock_key='specialized' AND dataset=? AND owner=? AND fence=? RETURNING fence`).bind(dataset, owner, fence).first();
        else throw new Error('지원하지 않는 lease 동작');
      } else if (path === '/import') {
        if (input.lease) {
          const guard = await DB.prepare('SELECT ok FROM p75_guard WHERE id=1').first();
          if (guard?.ok !== 1) throw new Error('lease guard 누락');
          if (!input.forceStaleWrite) {
            const lease = await DB.prepare(`SELECT fence FROM p75_leases WHERE lock_key='specialized'
              AND dataset=? AND owner=? AND fence=? AND expires_ms>${nowSql}`)
              .bind(input.lease.dataset, input.lease.owner, input.lease.fence).first();
            if (!lease) throw new Error('lease denied');
          }
        }
        const guarded = measuredDatabase(raw, metrics, input);
        const before = await counts(DB);
        result = await saveSpecializedMetrics(guarded, { status: 'parsed', ...input.document });
        const after = await counts(DB);
        result = { ...result, before, after, delta: Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]])) };
      } else if (path === '/verify') result = await verifyDocument(DB, input.document);
      else if (path === '/profile-race') {
        const original = await DB.prepare("SELECT ticker,name,cik,sector,industry FROM companies WHERE ticker='O'").first();
        const changed = { ...original, sector: 'Financial Services', industry: 'Banks - Regional' };
        await DB.batch([DB.prepare('UPDATE companies SET sector=?,industry=? WHERE ticker=?')
          .bind(changed.sector, changed.industry, changed.ticker), classificationStatement(DB, changed)]);
        let blocked = false;
        try {
          await DB.batch([DB.prepare(`UPDATE p75_guard SET ok=CASE WHEN EXISTS(SELECT 1 FROM companies
            WHERE ticker=? AND sector IS ? AND industry IS ?) THEN 1 ELSE 0 END WHERE id=1`)
            .bind(original.ticker, original.sector, original.industry), classificationStatement(DB, original)]);
        } catch (error) { if (!/CHECK constraint failed/.test(error.message)) throw error; blocked = true; }
        const current = await DB.prepare("SELECT effective_profile FROM company_classification WHERE ticker='O'").first();
        await DB.batch([DB.prepare('UPDATE companies SET sector=?,industry=? WHERE ticker=?')
          .bind(original.sector, original.industry, original.ticker), classificationStatement(DB, original)]);
        result = { staleBackfillBlocked: blocked, updatedProfilePreserved: current.effective_profile === 'BANK', restored: true };
      } else if (path === '/snapshot') {
        const index = tables.indexOf(input.table); if (index < 0) throw new Error('조회 table 오류');
        result = (await DB.prepare(`SELECT * FROM ${tables[index]} ORDER BY ${orders[index]} LIMIT ? OFFSET ?`)
          .bind(Math.min(input.limit || 100, 100), input.offset || 0).all()).results;
      } else if (path === '/query') result = await querySpecializedMetrics(DB, input);
      else if (path === '/probe') {
        if (!Number.isInteger(input.reads) || input.reads < 0 || input.reads > 60) throw new Error('probe 범위 오류');
        for (let index = 0; index < input.reads; index++) await DB.prepare('SELECT 1 one').first();
        result = { reads: input.reads };
      } else throw new Error('지원하지 않는 private rehearsal 경로');
      return Response.json({ ok: true, result, metrics: { ...metrics, wall_ms: Date.now() - start, cpu_ms: null } });
    } catch (error) {
      return Response.json({ ok: false, error: String(error.message), metrics: { ...metrics, wall_ms: Date.now() - start, cpu_ms: null } }, { status: 409 });
    }
  }
};
