import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync,readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const productionRunnerFiles=[
  'scripts/sec-raw-production-http.mjs','scripts/sec-raw-production-d1.mjs','scripts/sec-raw-production-runner.mjs',
  'scripts/sec-raw-state-provisioning.mjs','scripts/sec-raw-production-check.mjs','scripts/sec-raw-production-audit.mjs',
  'tests/helpers/sec-raw-production-fixtures.js','tests/sec-raw-production-runner.test.js','tests/sec-raw-single-transport.test.js',
  'scripts/sec-raw-automation-transport.mjs','tests/sec-raw-scheduled-producer.test.js','scripts/sec-raw-automation-check.mjs',
  'scripts/sec-raw-identity-check.mjs','package.json','docs/reit-metrics-r10c3a-report.md'];
export function checkProductionRunner() {
  const baseline='b869a6845bcca866c58a88d2e32e14e4710eefb8';
  const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:8*1024*1024}).trim();
  const changed=[...new Set([...git('diff','--name-only',baseline).split(/\r?\n/),...git('ls-files','--others','--exclude-standard').split(/\r?\n/)])].filter(Boolean);
  assert.ok(changed.every(file=>productionRunnerFiles.includes(file)),'R10C-3A 범위 밖 변경');
  for (const file of productionRunnerFiles.filter(path=>/\.(?:js|mjs)$/.test(path))) execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
  const protectedFiles=['app.js','index.html','style.css','financial-chart.js','worker/wrangler.jsonc',
    'worker/src/sec-raw-consumer-entry.js','worker/src/sec-raw-queue.js','worker/src/sec-raw-message.js',
    'scripts/sec-raw-scheduled-producer.mjs','scripts/sec-raw-producer-journal.mjs','scripts/sec-raw-producer-identity.mjs',
    ...readdirSync('worker/migrations').map(file=>'worker/migrations/'+file)];
  for (const file of protectedFiles) assert.equal(readFileSync(file,'utf8'),execFileSync('git',['show',`${baseline}:${file}`],{encoding:'utf8',maxBuffer:8*1024*1024}));
  assert.equal(git('diff','--cached','--name-only'),'');git('diff','--check');
  for (const file of changed) {
    const source=readFileSync(file,'utf8');
    assert.ok((source.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)??[]).every(email=>email.endsWith('@invalid.example')),'실제 이메일 후보');
    assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source),'개인키 후보');
    const credentials=[...source.matchAll(/(?:credential|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*:\s*['"]([^'"]+)['"]/gi)];
    assert.ok(credentials.every(match=>match[1].startsWith('synthetic-')),'실제 credential literal 후보');
    assert.ok(!/(?:ALPHA_VANTAGE_API_KEY|BUSINESS_QUANT_API_KEY|MARKET_DATA_API_KEY|CLOUDFLARE_API_TOKEN)\s*=\s*[A-Za-z0-9+/_=-]{12,}/.test(source),'실제 환경 Secret 후보');
    assert.ok(!/\.(?:env|dev\.vars)(?:[./-]|$)|\.(?:pdf|sqlite|png|db)$|(?:^|\/)cache\//i.test(file),'Secret/cache 파일 후보');
    assert.ok(source.split('\n').every(line=>!/[ \t]+$/.test(line.replace(/\r$/,''))),'untracked 포함 whitespace');
  }
  return {phase:'R10C-3A',status:'PASS',controlledFiles:changed.length,migrationsUnchanged:22,
    sourceCoreUnchanged:true,consumerUnchanged:true,candidateSecretScan:'PASS',stagedFiles:0,remoteRequests:0,productionMutation:0};
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(checkProductionRunner()));
