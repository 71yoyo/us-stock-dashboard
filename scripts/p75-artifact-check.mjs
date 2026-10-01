import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { semanticArtifact } from './p75-artifact.mjs';
import { hash } from './specialized-disposable-db.mjs';

// content-addressed 파일과 실행용 복사본 모두 manifest SHA에 맞아야 한다. path traversal도 허용하지 않는다.
export function readApprovedArtifact(directory = 'backups/p75') {
  const manifest = JSON.parse(readFileSync(`${directory}/manifest.json`, 'utf8'));
  assert.match(manifest.artifactFile, /^artifact-[a-f0-9]{64}\.json$/);
  const immutable = readFileSync(`${directory}/${manifest.artifactFile}`);
  assert.equal(createHash('sha256').update(immutable).digest('hex'), manifest.artifactFileDigest, 'artifact file hash mismatch');
  assert.deepEqual(readFileSync(`${directory}/artifact.json`), immutable, '실행용 artifact가 승인 파일과 다릅니다.');
  const artifact = JSON.parse(immutable);
  assert.equal(hash(semanticArtifact(artifact)), manifest.semanticArtifactDigest, 'artifact semantic hash mismatch');
  assert.deepEqual(artifact.expected, manifest.expected);
  return artifact;
}
