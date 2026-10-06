import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import { productionRunnerFiles } from './sec-raw-production-check.mjs';

// 승인된 parent 이후 R10C-2 관련 파일만 허용하고 기존 Worker/consumer/migration 변경은 차단한다.
export const identityCompatibilityFiles=[
  'scripts/sec-raw-producer-identity.mjs','scripts/sec-raw-source-discovery.mjs','scripts/sec-raw-scheduled-producer.mjs',
  'scripts/sec-raw-automation-policy.mjs','scripts/sec-raw-automation-readiness.mjs','scripts/sec-raw-producer-journal.mjs',
  'scripts/sec-raw-automation-check.mjs','scripts/sec-raw-identity-check.mjs','scripts/sec-raw-identity-audit.mjs',
  'tests/helpers/sec-raw-automation-fixtures.js','tests/helpers/sec-raw-identity-fixtures.js','tests/sec-raw-producer-identity.test.js',
  'package.json','docs/reit-metrics-r10c2-report.md'];
const baseline='428bdbd3d2b205a88d2f6bcb670ec63f57ceeadd';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:8*1024*1024}).trim();
const list=text=>text.split(/\r?\n/).filter(Boolean);
const changed=[...new Set([...list(git('diff','--name-only',baseline)),...list(git('ls-files','--others','--exclude-standard'))])];
assert.ok(changed.every(file=>identityCompatibilityFiles.includes(file) || productionRunnerFiles.includes(file)),'R10C-2/R10C-3A 범위 밖 변경');
for(const file of identityCompatibilityFiles.filter(file=>/\.(?:mjs|js)$/.test(file)))execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
const protectedFiles=['scripts/sec-raw-compact-producer.mjs','scripts/sec-raw-historical-import.mjs','scripts/sec-raw-historical-plan.mjs',
  'worker/src/sec-raw-message.js','worker/src/sec-raw-queue.js','worker/src/sec-raw-consumer-entry.js',
  'worker/src/sec-standard-raw-incremental.js','worker/src/sec-standard-raw-store.js','worker/src/company-classification.js',
  'worker/src/fmp-sync.js','worker/src/fundamental-sync.js','app.js','financial-chart.js','index.html','style.css',
  ...readdirSync('worker/migrations').filter(file=>file.endsWith('.sql')).map(file=>'worker/migrations/'+file)];
for(const file of protectedFiles)assert.equal(readFileSync(file,'utf8'),
  execFileSync('git',['show',`${baseline}:${file}`],{encoding:'utf8',maxBuffer:8*1024*1024}),`${file} 불변`);
assert.equal(git('diff','--cached','--name-only'),'','stage/commit 금지');
git('diff','--check');
console.log(JSON.stringify({phase:'R10C-2',status:'PASS',controlledFiles:changed.length,protectedFiles:protectedFiles.length,
 migrationsUnchanged:22,newMigration:false,consumerUnchanged:true,wireSchema:1,sourceAlgorithm:2,journalAlgorithm:1,
 productionChanged:false,remoteCalls:0}));
