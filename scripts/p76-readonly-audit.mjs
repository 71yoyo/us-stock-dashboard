import assert from 'node:assert/strict';
import { adminToken } from './specialized-d1-admin.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

// 배포된 실제 bundle/설정만 GET한다. 사용자 이메일·Secret·전체 bundle은 결과 파일에 남기지 않는다.
const account = '3b11130d1e729d56312f9ae504becc60';
const token = adminToken();
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
async function get(path) {
  const response = await fetch(`${base}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.ok(response.ok, `읽기 전용 감사 실패: HTTP ${response.status}`);
  return response;
}
const deployments = (await (await get('workers/scripts/us-stock-dashboard-api/deployments')).json()).result.deployments;
const before = deployments[0];
const modules = [];
const form = await (await get('workers/scripts/us-stock-dashboard-api')).formData();
for (const [name,value] of form) if (name.endsWith('.js')) modules.push({ name, text: typeof value === 'string' ? value : await value.text() });
assert.ok(modules.length > 0, '배포된 JavaScript module을 확보하지 못했습니다.');
modules.sort((a,b) => a.name.localeCompare(b.name));
const content = modules.map(row => row.text).join('\n');
const after = (await (await get('workers/scripts/us-stock-dashboard-api/deployments')).json()).result.deployments[0];
assert.equal(before.id, after.id, '감사 중 운영 버전 변경: 재검토 필요');
const pages = (await (await get('pages/projects')).json()).result.map(project => ({ name:project.name,
  production_branch:project.production_branch, source:project.source?.config ? {
    owner:project.source.config.owner, repo_name:project.source.config.repo_name,
    production_deployments_enabled:project.source.config.production_deployments_enabled,
    preview_deployment_setting:project.source.config.preview_deployment_setting,
    preview_branch_includes:project.source.config.preview_branch_includes,
    preview_branch_excludes:project.source.config.preview_branch_excludes } : null }));
const result = { checkedAt:new Date().toISOString(), production: {
  deploymentId:before.id,versionId:before.versions[0].version_id,createdAt:before.created_on,
  modules:modules.map(row => ({name:row.name,sha256:createHash('sha256').update(row.text).digest('hex')})),
  classificationTableMentions:(content.match(/company_classification/g)||[]).length,
  metadataWriter:content.includes('INSERT INTO companies'),
  classificationAware:content.includes('company_classification'),
  syncRoute:content.includes('/api/sync'),fundamentalScheduler:content.includes('scheduled') }, pages,
  workerBuildPolicy:{verifiedInP75:true,productionBranch:'main',nonProductionBranchBuilds:true},
  rawBundleStored:false,secretPrinted:false,settingsChanged:false };
mkdirSync('backups/p76',{recursive:true});
writeFileSync('backups/p76/read-only-audit.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
