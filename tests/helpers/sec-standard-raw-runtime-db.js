import { createMetricTestDatabase } from './specialized-metrics-db.js';

/** 실제 SQLite transaction과 SQL 실행 횟수를 기록한다. D1 과금/CPU 수치로 오인하지 않는다. */
export function createRawRuntimeDatabase(maxMigration = Infinity) {
  const { sqlite } = createMetricTestDatabase(true, maxMigration);
  const stats = [];
  let batchCalls = 0;
  let singleCalls = 0;
  const execute = (statement, mode) => {
    if (mode !== 'batch') singleCalls++;
    const before = sqlite.prepare('SELECT total_changes() n').get().n;
    const prepared = sqlite.prepare(statement.sql);
    const reads = mode === 'all' || mode === 'first' || prepared.columns().length > 0;
    const rows = reads ? prepared.all(...statement.values) : null;
    const result = rows ? mode === 'first' ? rows[0] || null : { results: rows }
      : prepared.run(...statement.values);
    stats.push({ sql: statement.sql, bindings: statement.values.length,
      bindBytes: Math.max(0, ...statement.values.filter(value => typeof value === 'string')
        .map(value => Buffer.byteLength(value))),
      logicalChanges: sqlite.prepare('SELECT total_changes() n').get().n - before });
    return result;
  };
  const DB = { prepare(sql) {
    return { sql, values: [], bind(...values) { this.values = values; return this; },
      async first() { return execute(this, 'first'); }, async all() { return execute(this, 'all'); },
      async run() { return execute(this, 'run'); } };
  }, async batch(statements) {
    batchCalls++;
    sqlite.exec('BEGIN');
    try { const results = statements.map(statement => execute(statement, 'batch'));
      sqlite.exec('COMMIT'); return results;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { sqlite, DB, stats, get batchCalls() { return batchCalls; }, get singleCalls() { return singleCalls; },
    reset() { stats.length = 0; batchCalls = 0; singleCalls = 0; } };
}
