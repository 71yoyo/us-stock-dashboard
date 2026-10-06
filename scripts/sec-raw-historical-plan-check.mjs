import { execFileSync } from 'node:child_process';
import { readFileSync,readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { assertAppConfigPreserved } from './app-deploy-config-check.mjs';

// 원격 도구를 실행하지 않는 문법/경계 검증이다. 기존 migration과 운영 설정을 수정하지 않는다.
const files=['scripts/sec-raw-historical-plan.mjs','scripts/sec-raw-historical-import.mjs',
  'scripts/sec-raw-historical-plan-audit.mjs','scripts/sec-raw-historical-plan-check.mjs',
  'worker/src/sec-standard-raw-store.js','worker/src/sec-standard-raw-incremental.js',
  'tests/sec-raw-historical-plan.test.js','tests/helpers/sec-raw-historical-reference.js'];
for(const file of files)execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
const migrations=readdirSync('worker/migrations').filter(file=>file.endsWith('.sql')).sort();
assert.equal(migrations.length,22);assert.match(migrations.at(-1),/^0022_/);
const baseline='607f93f2d7d7a2dbdb5684cf63db77987fdaf4be';
for(const file of migrations.map(name=>`worker/migrations/${name}`))
  assert.equal(readFileSync(file,'utf8'),execFileSync('git',['show',`${baseline}:${file}`],{encoding:'utf8'}));
// 승인된 Observability 추가만 예외다. D1/vars/Cron/raw flags 등 기존 설정은 계속 exact 보호한다.
assertAppConfigPreserved(JSON.parse(readFileSync('worker/wrangler.jsonc','utf8')),
  JSON.parse(execFileSync('git',['show',`${baseline}:worker/wrangler.jsonc`],{encoding:'utf8'})));
const importer=readFileSync('scripts/sec-raw-historical-import.mjs','utf8');
assert.match(importer,/requirePromotionEvidence\(evidence,verification.receipt\)/);
assert.match(importer,/prepareHistoricalMutationPlan/);assert.match(importer,/executeHistoricalMutationPlan/);
const queue=readFileSync('worker/src/sec-raw-consumer-entry.js','utf8');assert.doesNotMatch(queue,/historical-plan/);
console.log(JSON.stringify({status:'PASS',syntaxFiles:files.length,migrationsUnchanged:22,productionConfigUnchanged:true,remoteCalls:0}));
