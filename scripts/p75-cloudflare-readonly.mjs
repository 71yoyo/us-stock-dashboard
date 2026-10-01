import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Wrangler의 기존 인증을 읽기 전용 설정 조회에만 사용한다. token/환경값/Secret은 출력하거나 파일에 쓰지 않는다.
const auth = readFileSync(join(process.env.APPDATA, 'xdg.config/.wrangler/config/default.toml'), 'utf8');
const token = auth.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1]; assert.ok(token, 'Cloudflare 로그인이 필요합니다.');
const account = '3b11130d1e729d56312f9ae504becc60';
async function get(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await response.json();
  return { http: response.status, success: json.success, result: json.result, errors: json.errors?.map(error => ({ code: error.code, message: error.message })) };
}
const pages = await get('pages/projects');
const scripts = await get('workers/scripts');
const result = { pages: { http: pages.http, success: pages.success, projects: (pages.result || []).map(project => ({
  name: project.name, production_branch: project.production_branch, source: project.source,
  build_config: project.build_config, subdomain: project.subdomain })) }, workers: [] };
for (const script of scripts.result || []) {
  const triggers = await get(`builds/workers/${script.tag}/triggers`);
  result.workers.push({ name: script.id, tag: script.tag, triggersHttp: triggers.http,
    triggers: triggers.result?.map(trigger => ({ trigger_uuid: trigger.trigger_uuid, build_name: trigger.build_name,
      branch_includes: trigger.branch_includes, branch_excludes: trigger.branch_excludes,
      build_command: trigger.build_command, deploy_command: trigger.deploy_command, root_directory: trigger.root_directory,
      repo_connection_uuid: trigger.repo_connection_uuid, external_script_id: trigger.external_script_id,
      production_branch: trigger.production_branch })), errors: triggers.errors });
}
writeFileSync('backups/p75/auto-deploy.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
