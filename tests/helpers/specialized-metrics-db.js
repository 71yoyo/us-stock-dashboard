import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

// D1이 아닌 실제 메모리 SQLite에서 제약조건과 트랜잭션을 실행한다.
export function createMetricTestDatabase(includeNewMigration = true, maxMigration = Infinity) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../../worker/migrations/', import.meta.url)).sort()) {
    if (Number(name.slice(0, 4)) > maxMigration) break;
    if (!includeNewMigration && name.startsWith('0018_')) break;
    sqlite.exec(readFileSync(new URL(`../../worker/migrations/${name}`, import.meta.url), 'utf8'));
  }
  const prepare = sql => ({ sql, values: [], bind(...values) { this.values = values; return this; },
    async first() { return sqlite.prepare(sql).get(...this.values) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...this.values) }; },
    async run() { return sqlite.prepare(sql).run(...this.values); }
  });
  const DB = { prepare, async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const result = statements.map(statement => sqlite.prepare(statement.sql).run(...statement.values));
      sqlite.exec('COMMIT'); return result;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { sqlite, DB };
}

export function seedProtectedMetrics(sqlite) {
  const columns = sqlite.prepare('PRAGMA table_info(financial_metrics)').all();
  const numericColumns = columns.filter(column => /REAL|INTEGER/i.test(column.type)).map(column => column.name);
  for (const [index, ticker] of ['O', 'JPM', 'TEST'].entries()) {
    sqlite.prepare('INSERT INTO companies(ticker,name) VALUES (?,?)').run(ticker, ticker);
    // NULL・ゼロ・負数を含む既存全数値列を埋め、分類overrideも保護対象にする。
    const values = numericColumns.map((column, position) => column === 'fiscal_year' ? 2025
      : column === 'metadata_version' ? 1 : [null, 0, -12.5, 987654][(position + index) % 4]);
    sqlite.prepare(`INSERT INTO financial_metrics(ticker,period_type,fiscal_period_end,source,${numericColumns.join(',')})
      VALUES (?,?,?,?,${values.map(() => '?').join(',')})`).run(ticker, 'annual', '2025-12-31', 'SYNTHETIC_REGRESSION', ...values);
    sqlite.prepare(`INSERT INTO company_classification(ticker,auto_profile,effective_profile,classification_reason,
      confidence,rule_version,manual_override,manual_override_reason,review_status,classified_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ticker, 'UNKNOWN', 'REIT', '로컬 회귀검증', 'low', 1, 'REIT', '수동 검증', 'overridden', '2026-09-30');
  }
}

export function protectedDigest(sqlite) {
  const snapshot = ['financial_metrics', 'company_classification'].map(table => ({ table,
    rows: sqlite.prepare(`SELECT * FROM ${table} ORDER BY ticker`).all() }));
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
