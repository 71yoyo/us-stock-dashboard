import { execFileSync } from 'node:child_process';
import { readFileSync,readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { productionRunnerFiles } from './sec-raw-production-check.mjs';
export const automationFiles=[
  'scripts/sec-raw-automation-policy.mjs','scripts/sec-raw-source-fetch.mjs','scripts/sec-raw-producer-journal.mjs',
  'scripts/sec-raw-github-journal.mjs','scripts/sec-raw-automation-readiness.mjs','scripts/sec-raw-source-discovery.mjs',
  'scripts/sec-raw-automation-transport.mjs','scripts/sec-raw-scheduled-producer.mjs','scripts/sec-raw-automation-check.mjs',
  'scripts/sec-raw-automation-audit.mjs','tests/helpers/sec-raw-automation-fixtures.js','tests/sec-raw-automation-policy.test.js',
  'tests/sec-raw-source-fetch.test.js','tests/sec-raw-producer-journal.test.js','tests/sec-raw-scheduled-producer.test.js','tests/sec-raw-github-journal.test.js',
  // R10C-2는 승인된 producer-side 확장만 허용한다. consumer/Worker/migration allowlist는 확장하지 않는다.
  'scripts/sec-raw-producer-identity.mjs','scripts/sec-raw-identity-audit.mjs','scripts/sec-raw-identity-check.mjs',
  'tests/helpers/sec-raw-identity-fixtures.js','tests/sec-raw-producer-identity.test.js'
];
const baseline='9fbf7a5deeb67fda8e94aab9d3f28d8fcc7582c6';
const allowed=new Set([...automationFiles,...productionRunnerFiles,'package.json','docs/reit-metrics-r10b-report.md','docs/reit-metrics-r10c2-report.md']);
const changed=execFileSync('git',['diff','--name-only',baseline],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
assert.ok(changed.every(file=>allowed.has(file)),'R10B 범위 밖 변경');
const untracked=execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
assert.ok(untracked.every(file=>allowed.has(file)),'예상하지 못한 untracked 파일');
for (const file of automationFiles) execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
for (const file of [...new Set([...changed,...untracked])]) {
  const text=readFileSync(file,'utf8');
  assert.ok(text.split('\n').every(line=>!/[ \t]+$/.test(line.replace(/\r$/,''))),'신규 파일 포함 trailing whitespace');
  const emails=text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)??[];
  assert.ok(emails.every(value=>value.endsWith('@invalid.example')),'실제 이메일 후보 포함');
  const credentials=[...text.matchAll(/(?:credential|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*:\s*['"]([^'"]+)['"]/gi)];
  assert.ok(credentials.every(match=>match[1].startsWith('synthetic-')),'실제 credential literal 후보 포함');
  assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text),'개인키 포함');
  assert.ok(!/(?:ALPHA_VANTAGE_API_KEY|BUSINESS_QUANT_API_KEY|MARKET_DATA_API_KEY|CLOUDFLARE_API_TOKEN)\s*=\s*[A-Za-z0-9+/_=-]{12,}/.test(text),'환경 Secret 실제 값 포함');
}
const migrations=readdirSync('worker/migrations').filter(file=>file.endsWith('.sql')).sort();
assert.equal(migrations.length,22);
for (const name of migrations) assert.equal(readFileSync('worker/migrations/'+name,'utf8'),execFileSync('git',['show',`${baseline}:worker/migrations/${name}`],{encoding:'utf8'}));
// 기존 consumer graph에 새 producer를 연결하지 않았는지는 baseline diff allowlist가 함께 보호한다.
assert.equal(execFileSync('git',['diff','--cached','--name-only'],{encoding:'utf8'}).trim(),'','이번 Phase는 stage/commit하지 않는다');
console.log(JSON.stringify({phase:'R10B',status:'PASS',syntaxFiles:automationFiles.length,migrationsUnchanged:22,
  candidateSecretScan:'PASS',candidateWhitespace:'PASS',stagedFiles:0,workflowConnected:false,productionPolicyCreated:false,remoteCalls:0}));
