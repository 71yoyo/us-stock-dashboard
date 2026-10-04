import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// dry build만 수행한다. wrangler deploy/Cloudflare credential/remote config에는 접근하지 않는다.
const files=['scripts/sec-raw-promotion.mjs','scripts/sec-raw-historical-import.mjs','scripts/sec-raw-queue-transport.mjs',
  'scripts/sec-raw-discovery-runner.mjs','scripts/sec-raw-promotion-audit.mjs','scripts/sec-raw-promotion-check.mjs',
  'worker/src/sec-raw-runtime-policy.js','worker/src/sec-raw-consumer-entry.js','worker/src/sec-raw-queue.js',
  'tests/sec-raw-promotion.test.js','tests/helpers/sec-raw-promotion-fixtures.js'];
for(const file of files) execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
const result=await build({entryPoints:['worker/src/sec-raw-consumer-entry.js'],bundle:true,write:false,
  platform:'browser',format:'esm',metafile:true});
const graph=Object.keys(result.metafile.inputs),code=result.outputFiles[0].text;
assert.doesNotMatch(graph.join('\n'),/fmp-sync|fundamental-sync|sec-standard-raw-runtime\.js|scripts\/|app\.js|index\.js/);
assert.doesNotMatch(code,/runStandardRawRuntime|syncFinancialsFromSec|runFundamentalBatch|async scheduled|async fetch/);
const config=JSON.parse(readFileSync('worker/sec-raw-consumer.template.jsonc','utf8'));
assert.equal(config.vars.SEC_STANDARD_RAW_QUEUE_ENABLED,'false');assert.equal(config.triggers,undefined);
assert.equal(config.queues.consumers[0].max_batch_size,1);assert.equal(config.queues.consumers[0].max_concurrency,1);
assert.equal(config.queues.consumers[0].max_retries,5);assert.equal(config.queues.consumers[0].retry_delay,900);
assert.match(config.d1_databases[0].database_id,/^REPLACE_/);
console.log(JSON.stringify({status:'PASS',syntaxFiles:files.length,queueOnlyGraph:graph,bundleBytes:result.outputFiles[0].contents.length,
  fetch:false,scheduled:false,fullRuntime:false,productionChanged:false},null,2));
