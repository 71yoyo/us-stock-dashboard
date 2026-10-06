import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const APP_DEPLOY_BASELINE = '0ff71e8da69197b0258727b2229a499207ab33d1';
export const WRANGLER_DEPLOY_VERSION = '4.136.1';
// R11B-1H의 운영 관측에서 승인된 의미만 명시한다. destinations/issues 등은 추가하지 않는다.
export const EXPECTED_OBSERVABILITY = {
  enabled: true,
  head_sampling_rate: 1,
  logs: {enabled: true, head_sampling_rate: 1, invocation_logs: true, persist: true},
  traces: {enabled: false}
};

export function assertAppConfigPreserved(candidate, baseline) {
  const {observability, ...existing} = candidate;
  const {observability: previous, ...original} = baseline;
  assert.deepEqual(existing, original, 'Observability 이외 App config 변경 금지');
  assert.deepEqual(observability, EXPECTED_OBSERVABILITY, '승인 Observability 상태 exact 필요');
}

// 별도 dependency를 추가하지 않고 설치된 공식 schema의 현재 config 경로를 엄격히 검사한다.
// 처리하지 않는 validation keyword는 통과시키지 않는다. 최종 normalization은 Wrangler 자체로 재검증한다.
export function assertConfigSchema(value, schema) {
  function validate(value, rule, location) {
    if (rule.$ref) {
      assert(rule.$ref.startsWith('#/definitions/'), '외부 schema 참조는 허용하지 않음');
      return validate(value, schema.definitions[rule.$ref.split('/').at(-1)], location);
    }
    const supported = new Set(['type','properties','additionalProperties','items','required','anyOf',
      'enum','description','markdownDescription','default','deprecated']);
    assert(Object.keys(rule).every(key=>supported.has(key)), `${location}: 지원하지 않는 schema 조건`);
    assert(!rule.deprecated, `${location}: deprecated field 금지`);
    if (rule.anyOf) {
      assert(rule.anyOf.some(option=>{try {validate(value,option,location);return true;} catch {return false;}}), `${location}: schema anyOf 불일치`);
      return;
    }
    if (rule.enum) assert(rule.enum.includes(value), `${location}: enum 불일치`);
    const actual = value===null?'null':Array.isArray(value)?'array':typeof value;
    if (rule.type) assert(actual===rule.type || (rule.type==='integer'&&Number.isInteger(value)), `${location}: 타입 불일치`);
    if (actual==='number') assert(Number.isFinite(value), `${location}: 유한 숫자 필요`);
    if (actual==='object') {
      for (const key of rule.required??[]) assert(Object.hasOwn(value,key), `${location}.${key}: 필수 field 누락`);
      for (const [key,child] of Object.entries(value)) {
        const childRule=rule.properties?.[key];
        if (childRule) validate(child,childRule,`${location}.${key}`);
        else {
          assert(rule.additionalProperties!==false, `${location}.${key}: unknown field`);
          if (rule.additionalProperties && typeof rule.additionalProperties==='object') validate(child,rule.additionalProperties,`${location}.${key}`);
        }
      }
    }
    if (actual==='array' && rule.items) value.forEach((child,index)=>validate(child,rule.items,`${location}[${index}]`));
  }
  validate(value,schema.definitions.RawConfig,'config');
}

export function assertWranglerVersionPin(pkg) {
  assert.equal(pkg.devDependencies.wrangler,WRANGLER_DEPLOY_VERSION,'Wrangler exact version pin 필요');
}

export function assertCleanInstallVersion(cliOutput, resolvedVersion) {
  // CLI banner만 믿지 않고 fresh node_modules의 실제 package version도 동시에 대조한다.
  assert.equal(cliOutput.trim(),WRANGLER_DEPLOY_VERSION,'clean npx Wrangler 버전 불일치');
  assert.equal(resolvedVersion,WRANGLER_DEPLOY_VERSION,'clean resolved package 버전 불일치');
}

export async function checkAppDeployConfig() {
  const candidate=JSON.parse(readFileSync('worker/wrangler.jsonc','utf8'));
  const baseline=JSON.parse(execFileSync('git',['show',`${APP_DEPLOY_BASELINE}:worker/wrangler.jsonc`],{encoding:'utf8'}));
  assertAppConfigPreserved(candidate,baseline);
  assertConfigSchema(candidate,JSON.parse(readFileSync('node_modules/wrangler/config-schema.json','utf8')));
  assertWranglerVersionPin(JSON.parse(readFileSync('package.json','utf8')));
  assert.equal(JSON.parse(readFileSync('node_modules/wrangler/package.json','utf8')).version,WRANGLER_DEPLOY_VERSION);
  // 정규화 API는 로컬 설정만 읽는다. OAuth/Production API/dev 환경값 조회는 하지 않는다.
  const {unstable_readConfig}=await import('wrangler');
  const normalized=unstable_readConfig({config:resolve('worker/wrangler.jsonc')},{preserveOriginalMain:true});
  assert.deepEqual(normalized.observability,candidate.observability,'Wrangler가 field를 누락/무시함');
  return {status:'PASS',schemaValid:true,unknownFields:0,ignoredFields:0,observability:normalized.observability,
    wrangler:WRANGLER_DEPLOY_VERSION,existingConfigUnchanged:true,remoteRequests:0,productionMutation:0};
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await checkAppDeployConfig()));
}
