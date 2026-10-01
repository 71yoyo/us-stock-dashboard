import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

// 운영 설정은 읽기만 한다. 명시적인 확인과 실제 remote identity 확인 없이 쓰기를 시작하지 않는다.
export const rehearsalName = 'us-stock-dashboard-p75-rehearsal-20261001';
export const rehearsalId = 'de3f265c-d6ec-4561-8a53-64effad66eb5';
export const productionId = '698ab9b8-4573-40c7-b119-d7b1d681abc8';
export const output = resolve('backups/p75');
export function wrangler(args) {
  return execFileSync(process.execPath, ['--use-system-ca', 'node_modules/wrangler/bin/wrangler.js', ...args],
    { encoding: 'utf8', input: 'y\n', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: 'true' } });
}
export function assertDisposable(config) {
  assert.equal(config.name, rehearsalName);
  assert.equal(config.vars.REHEARSAL_MARKER, 'P75_DISPOSABLE_ONLY');
  assert.equal(config.vars.CONFIRM_DISPOSABLE, 'YES');
  assert.equal(config.d1_databases.length, 1);
  assert.deepEqual(config.d1_databases[0].database_id, rehearsalId);
  assert.equal(config.d1_databases[0].database_name, rehearsalName);
  assert.equal(config.d1_databases[0].binding, 'REHEARSAL_DB');
  assert.notEqual(rehearsalId, productionId);
  assert.equal(config.workers_dev, false);
  assert.ok(!config.triggers && !config.routes);
}
if (process.argv[1] === resolve('scripts/p75-prepare.mjs')) {
  assert.ok(process.argv.includes('--confirm-disposable'), '전용 disposable 확인 flag가 필요합니다.');
  const info = JSON.parse(wrangler(['d1', 'info', rehearsalName, '--json']));
  assert.equal(info.uuid, rehearsalId); assert.equal(info.name, rehearsalName);
  const production = JSON.parse(readFileSync('worker/wrangler.jsonc', 'utf8'));
  assert.equal(production.d1_databases[0].database_id, productionId);
  mkdirSync(output, { recursive: true });
  const migrations = readdirSync('worker/migrations').filter(name => name.endsWith('.sql')).sort();
  for (const stage of [16, 17, 18]) {
    const directory = join(output, `migrations-${stage}`); mkdirSync(directory, { recursive: true });
    for (const name of migrations.filter(name => Number(name.slice(0, 4)) <= stage)) copyFileSync(join('worker/migrations', name), join(directory, name));
    const config = { name: rehearsalName, main: resolve('scripts/p75-worker.js'), compatibility_date: '2026-09-21',
      workers_dev: false, preview_urls: false,
      vars: { REHEARSAL_MARKER: 'P75_DISPOSABLE_ONLY', CONFIRM_DISPOSABLE: 'YES', REHEARSAL_DATABASE_ID: rehearsalId },
      d1_databases: [{ binding: 'REHEARSAL_DB', database_name: rehearsalName, database_id: rehearsalId, migrations_dir: directory }] };
    assertDisposable(config);
    const path = join(output, `config-${stage}.json`); writeFileSync(path, JSON.stringify(config, null, 2));
    const result = wrangler(['d1', 'migrations', 'apply', rehearsalName, '--remote', '--config', path]);
    writeFileSync(join(output, `migration-${stage}.txt`), result);
    const schema = wrangler(['d1', 'execute', rehearsalName, '--remote', '--config', path, '--json', '--command',
      "SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name; SELECT name FROM d1_migrations ORDER BY id;"]);
    writeFileSync(join(output, `schema-${stage}.json`), schema);
    const tables = JSON.parse(schema)[0].results.map(row => row.name);
    assert.equal(tables.includes('company_classification'), stage >= 17);
    assert.equal(tables.includes('company_metric_values'), stage >= 18);
    console.log(JSON.stringify({ stage, verified: true, migrations: JSON.parse(schema)[1].results.length }));
  }
  writeFileSync(join(output, 'identity.json'), JSON.stringify({ ...info, productionSeparated: true }, null, 2));
}
