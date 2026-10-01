import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hash } from './specialized-disposable-db.mjs';
import { semanticArtifact } from './p75-artifact.mjs';

export const DATASET_KEY = 'REALTY_INCOME_FFO_AFFO_2016_2025_V1';
export const TARGETS = Object.freeze({
  production: { id: '698ab9b8-4573-40c7-b119-d7b1d681abc8', name: 'us-stock-pro' },
  rehearsal: { id: 'de3f265c-d6ec-4561-8a53-64effad66eb5', name: 'us-stock-dashboard-p75-rehearsal-20261001' }
});
export function validateOptions(options) {
  const environment = options.rehearsal ? 'rehearsal' : 'production';
  const target = TARGETS[environment];
  for (const name of ['dbId','dbName','artifact','datasetVersion','artifactSha256','expectedDbName']) {
    assert.ok(typeof options[name] === 'string' && options[name], `SAFE FAIL: --${name}가 필요합니다.`);
  }
  assert.equal(options.dbId, target.id, 'SAFE FAIL: DB ID allowlist 불일치');
  assert.equal(options.dbName, target.name, 'SAFE FAIL: DB name allowlist 불일치');
  assert.equal(options.expectedDbName, target.name, 'SAFE FAIL: expected DB name 불일치');
  assert.match(options.artifactSha256, /^[a-f0-9]{64}$/);
  assert.ok(!(options.apply && options.verifyOnly), 'apply/verify-only 동시 지정 금지');
  if (options.apply) assert.equal(options[environment === 'production' ? 'confirmProduction' : 'confirmRehearsal'], target.name,
    'SAFE FAIL: apply에는 대상 이름을 포함한 명시적인 confirmation이 필요합니다.');
  if (environment === 'production') assert.ok(options.approval, 'SAFE FAIL: production 승격 승인 envelope가 필요합니다.');
  return { ...options, environment, verifyOnly: !options.apply };
}
export function loadImportArtifact(options) {
  const bytes = readFileSync(options.artifact);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), options.artifactSha256, 'artifact hash mismatch');
  const artifact = JSON.parse(bytes);
  const approved = JSON.parse(readFileSync(new URL('../docs/realty-income-phase-p75-results.json', import.meta.url), 'utf8')).artifact;
  assert.equal(artifact.datasetVersion, options.datasetVersion, 'dataset identity mismatch');
  assert.equal(artifact.parserCommit, approved.parserCommit, 'parser commit mismatch');
  assert.equal(hash(semanticArtifact(artifact)), approved.semanticArtifactDigest, 'artifact semantic hash mismatch');
  assert.equal(artifact.documents.length, 40);
  const sourceMap = new Map(approved.sources.map(row => [row.id, row]));
  assert.equal(new Set(artifact.documents.map(row => row.id)).size, 40);
  for (const document of artifact.documents) {
    const source = sourceMap.get(document.id);
    assert.ok(source && source.source_hash === document.source_hash && source.url === document.url
      && document.cik === '0000726728', '승인 source hash/issuer 불일치');
  }
  assert.deepEqual(artifact.expected, approved.expected);
  const identity = { dataset_key: DATASET_KEY, dataset_version: artifact.datasetVersion,
    target_db_id: options.dbId, target_db_name: options.dbName, target_environment: options.environment,
    artifact_sha256: options.artifactSha256, semantic_digest: approved.semanticArtifactDigest, parser_commit: artifact.parserCommit };
  if (options.environment === 'production') {
    // proof payload를 운영에 자동 승격하지 않는다. 별도 release 승인이 대상/bytes/의미를 모두 고정해야 한다.
    const approval = JSON.parse(readFileSync(options.approval, 'utf8'));
    assert.equal(approval.productionPromotionApproved, true, 'production artifact 승격 미승인');
    assert.deepEqual(approval.identity, identity, 'production/rehearsal approval target 불일치');
  }
  return { artifact, identity };
}
export function parseArguments(args) {
  const booleans = new Set(['apply','verify-only','rehearsal']);
  const names = new Set(['db-id','db-name','artifact','dataset-version','artifact-sha256','expected-db-name',
    'confirm-production','confirm-rehearsal','approval','account-id']);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index].replace(/^--/, '');
    assert.ok(args[index].startsWith('--') && (booleans.has(key) || names.has(key)), '미지원 importer 옵션');
    const name = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    assert.ok(options[name] === undefined, '중복 importer 옵션');
    options[name] = booleans.has(key) ? true : args[++index];
    assert.ok(options[name] && !String(options[name]).startsWith('--'), 'importer 옵션 값 누락');
  }
  return validateOptions(options);
}
