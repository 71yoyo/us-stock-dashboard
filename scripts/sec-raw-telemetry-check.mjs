import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {rawTelemetryEnabled} from '../worker/src/sec-raw-telemetry.js';

// 로컬 syntax/bundle만 확인한다. 배포·credential·환경파일·원격 API에는 접근하지 않는다.
const files=['worker/src/sec-raw-telemetry.js','worker/src/sec-raw-queue.js',
 'worker/src/sec-raw-consumer-entry.js','tests/sec-raw-telemetry.test.js',
 'tests/helpers/sec-raw-telemetry-db.js','scripts/sec-raw-telemetry-check.mjs','scripts/sec-raw-telemetry-audit.mjs'];
for(const file of files)execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
const bundle=await build({entryPoints:['worker/src/sec-raw-consumer-entry.js'],bundle:true,write:false,
 platform:'browser',format:'esm',metafile:true});
const graph=Object.keys(bundle.metafile.inputs),code=bundle.outputFiles[0].text;
assert.ok(graph.includes('worker/src/sec-raw-telemetry.js'));
assert.doesNotMatch(graph.join('\n'),/fmp-sync|fundamental-sync|sec-standard-raw-runtime\.js|scripts\/|app\.js|index\.js/);
assert.doesNotMatch(code,/async scheduled|async fetch|cpuMs\s*:/);
const template=JSON.parse(readFileSync('worker/sec-raw-consumer.template.jsonc','utf8'));
assert.equal(rawTelemetryEnabled(template.vars),false);
assert.equal(template.vars.SEC_STANDARD_RAW_QUEUE_ENABLED,'false');
assert.equal(template.queues.consumers[0].max_batch_size,1);
assert.equal(template.observability,undefined);
console.log(JSON.stringify({status:'PASS',syntaxFiles:files.length,queueOnlyGraph:graph,
 bundleBytes:bundle.outputFiles[0].contents.length,telemetryDefault:'OFF',productionChanged:false},null,2));
