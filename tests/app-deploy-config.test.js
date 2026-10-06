import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {mkdtemp,copyFile,rm,lstat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {buildPages,FRONTEND_ASSETS} from '../scripts/build-pages.mjs';
import {APP_DEPLOY_BASELINE,EXPECTED_OBSERVABILITY,WRANGLER_DEPLOY_VERSION,
  assertAppConfigPreserved,assertConfigSchema,assertWranglerVersionPin,assertCleanInstallVersion,checkAppDeployConfig} from '../scripts/app-deploy-config-check.mjs';

const config=JSON.parse(readFileSync('worker/wrangler.jsonc','utf8'));
const baseline=JSON.parse(execFileSync('git',['show',`${APP_DEPLOY_BASELINE}:worker/wrangler.jsonc`],{encoding:'utf8'}));
const schema=JSON.parse(readFileSync('node_modules/wrangler/config-schema.json','utf8'));
const pkg=JSON.parse(readFileSync('package.json','utf8'));

for (const [label,read,expected] of [
  ['enabled',c=>c.observability.enabled,true],
  ['top sampling',c=>c.observability.head_sampling_rate,1],
  ['logs enabled',c=>c.observability.logs.enabled,true],
  ['logs sampling',c=>c.observability.logs.head_sampling_rate,1],
  ['invocation logs',c=>c.observability.logs.invocation_logs,true],
  ['persist',c=>c.observability.logs.persist,true],
  ['traces',c=>c.observability.traces.enabled,false]
]) test(`App Observability ${label}은 운영 확인값 exact`,()=>assert.equal(read(config),expected));

test('Observability는 승인된 field만 포함하며 원래 설정을 보존',()=>{
  assert.deepEqual(config.observability,EXPECTED_OBSERVABILITY);
  assertAppConfigPreserved(config,baseline);
});
test('설치된 공식 Wrangler schema 전체 candidate 경로 검증',()=>assertConfigSchema(config,schema));
test('unknown top-level / Observability / logs field는 fail-closed',()=>{
  for(const target of [c=>c,c=>c.observability,c=>c.observability.logs]) {
    const changed=structuredClone(config);target(changed).unknown_field=true;
    assert.throws(()=>assertConfigSchema(changed,schema),/unknown field/);
  }
});
test('Observability field 타입 오류는 거부',()=>{
  const changed=structuredClone(config);changed.observability.logs.persist='true';
  assert.throws(()=>assertConfigSchema(changed,schema),/타입 불일치/);
});
test('D1 exact unchanged',()=>assert.deepEqual(config.d1_databases,baseline.d1_databases));
test('public vars exact unchanged',()=>assert.deepEqual(config.vars,baseline.vars));
test('Cron 5 exact unchanged',()=>{
  assert.deepEqual(config.triggers,baseline.triggers);assert.equal(config.triggers.crons.length,5);
});
test('raw flags remain OFF/unset 및 App Queue binding 없음',()=>{
  assert.equal(config.vars.SEC_STANDARD_RAW_FIELDS_ENABLED,undefined);
  assert.equal(config.vars.SEC_STANDARD_RAW_QUEUE_ENABLED,undefined);assert.equal(config.queues,undefined);
});
test('D1/vars/Cron/compatibility/routes drift는 Observability 예외로 숨기지 않음',()=>{
  for(const mutate of [c=>c.d1_databases[0].database_id='changed',c=>c.vars.DIVIDEND_PIPELINE_ENABLED='false',
    c=>c.triggers.crons.pop(),c=>c.compatibility_date='2026-10-07',c=>c.workers_dev=false]) {
    const changed=structuredClone(config);mutate(changed);
    assert.throws(()=>assertAppConfigPreserved(changed,baseline),/Observability 이외/);
  }
});
test('Wrangler dependency는 4.136.1 exact pin이며 semver 범위 거부',()=>{
  assertWranglerVersionPin(pkg);assert.equal(WRANGLER_DEPLOY_VERSION,'4.136.1');
  const changed=structuredClone(pkg);changed.devDependencies.wrangler='^4.136.1';
  assert.throws(()=>assertWranglerVersionPin(changed));
});
test('Wrangler 자체 정규화 결과에서 모든 Observability field 유지',async()=>{
  const result=await checkAppDeployConfig();assert.equal(result.status,'PASS');
  assert.deepEqual(result.observability,EXPECTED_OBSERVABILITY);assert.equal(result.ignoredFields,0);
});
test('clean install version receipt는 CLI/package exact 일치만 허용',()=>{
  assertCleanInstallVersion('4.136.1\n','4.136.1');
  for(const values of [['4.136.0','4.136.1'],['4.136.1','4.136.2'],['4.136.1\n경고','4.136.1']]) {
    assert.throws(()=>assertCleanInstallVersion(...values));
  }
});
test('실제 frontend는 candidate에서도 Pages 10 exact / unexpected 0',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'stock-app-config-pages-'));
  t.after(async()=>{
    // 이 테스트가 만든 Temp만 정리하며 기존 사용자/프로젝트 경로는 삭제하지 않는다.
    assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('stock-app-config-pages-'));
    assert(!(await lstat(root)).isSymbolicLink());await rm(root,{recursive:true});
  });
  for(const file of FRONTEND_ASSETS)await copyFile(file,path.join(root,file));
  const result=await buildPages({projectRoot:root});assert.equal(result.fileCount,10);assert.equal(result.unexpected,0);
});
