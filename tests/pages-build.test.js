import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildPages, compareAssetBytes, FRONTEND_ASSETS, PAGES_OUTPUT_DIRECTORY,
  validateFrontendAssetPath, verifyPagesArtifact } from '../scripts/build-pages.mjs';

const EXPECTED = ['app.js', 'cloudflare-config.js', 'financial-chart.js', 'fundamental-progress.css',
  'fundamental-progress.js', 'index.html', 'reit-financial-chart.js', 'style.css', 'tradingview-widget.js', 'williams-signal.js'];
const repo = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stock-pages-test-'));
  t.after(async () => {
    // 테스트가 직접 생성한 Temp 루트만 삭제한다. 프로젝트/사용자 디렉터리 삭제는 허용하지 않는다.
    assert.equal(path.dirname(root), os.tmpdir());
    assert(path.basename(root).startsWith('stock-pages-test-'));
    assert(!(await lstat(root)).isSymbolicLink());
    await rm(root, { recursive: true });
  });
  for (const file of EXPECTED) await writeFile(path.join(root, file), `// 공개 테스트 파일: ${file}\r\n`);
  return root;
}

const code = expected => error => error.code === expected;

test('Pages allowlist는 R11A의 프런트엔드 10개 exact이며 변경 불가', () => {
  assert.deepEqual(FRONTEND_ASSETS, EXPECTED);
  assert.equal(FRONTEND_ASSETS.length, 10);
  assert(Object.isFrozen(FRONTEND_ASSETS));
  assert.equal(PAGES_OUTPUT_DIRECTORY, '.pages-dist');
});

test('실제 index의 로컬 CSS/JS graph와 allowlist가 exact', () => {
  const html = readFileSync(path.join(repo, 'index.html'), 'utf8');
  const references = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"#]+)"/g)]
    .map(match => match[1]).filter(value => !/^(https?:|\/\/)/.test(value))
    .map(value => value.split('?')[0]);
  assert.deepEqual([...new Set(['index.html', ...references])].sort(), EXPECTED);
});

test('Pages build는 정확히 10개만 byte-for-byte 복사', async t => {
  const root = await fixture(t);
  const result = await buildPages({ projectRoot: root });
  assert.equal(result.fileCount, 10);
  assert.equal(result.unexpected, 0);
  assert.deepEqual(result.assets.map(row => row.path), EXPECTED);
  for (const file of EXPECTED) assert.deepEqual(await readFile(path.join(root, '.pages-dist', file)), await readFile(path.join(root, file)));
});

test('Pages build는 기존 frontend source를 수정하지 않음', async t => {
  const root = await fixture(t);
  const before = await Promise.all(EXPECTED.map(file => readFile(path.join(root, file))));
  await buildPages({ projectRoot: root });
  const after = await Promise.all(EXPECTED.map(file => readFile(path.join(root, file))));
  assert.deepEqual(after, before);
});

test('필수 frontend 누락은 fail-closed, 산출물 새 생성 없음', async t => {
  const root = await fixture(t);
  await rm(path.join(root, 'index.html'));
  await assert.rejects(buildPages({ projectRoot: root }), code('SOURCE_MISSING'));
  assert(!(await readdir(root)).includes('.pages-dist'));
});

test('디렉터리를 frontend source로 사용하면 실패', async t => {
  const root = await fixture(t);
  await rm(path.join(root, 'app.js'));
  await mkdir(path.join(root, 'app.js'));
  await assert.rejects(buildPages({ projectRoot: root }), code('REGULAR_FILE_REQUIRED'));
});

test('server/secret/cache/package/workflow는 입력에 있어도 복사하지 않음', async t => {
  const root = await fixture(t);
  const forbidden = ['worker/src/index.js', 'worker/migrations/0001.sql', 'scripts/build-pages.mjs',
    'tests/example.test.js', 'docs/example.md', '.github/workflows/example.yml', 'migrations/extra.sql',
    'backups/private.json', '.env', '.env.example', '.dev.vars.local', 'cache/CompanyFacts.json',
    'private.sqlite', 'original.pdf', 'credential.json', 'package.json', 'package-lock.json'];
  for (const file of forbidden) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), '테스트용 비공개 분류 표식 — 실제 credential 아님');
  }
  const result = await buildPages({ projectRoot: root });
  assert.deepEqual(result.assets.map(row => row.path), EXPECTED);
  for (const file of forbidden) assert(!result.assets.some(row => row.path === file));
});

test('extra output 파일을 검증에서 거부', async t => {
  const root = await fixture(t);
  await buildPages({ projectRoot: root });
  await writeFile(path.join(root, '.pages-dist', 'secret.json'), '실제 정보 없는 표식');
  await assert.rejects(verifyPagesArtifact(path.join(root, '.pages-dist')), code('ARTIFACT_FILE_SET_MISMATCH'));
});

test('빈 extra output 디렉터리도 검증에서 거부', async t => {
  const root = await fixture(t);
  await buildPages({ projectRoot: root });
  await mkdir(path.join(root, '.pages-dist', 'worker'));
  await assert.rejects(verifyPagesArtifact(path.join(root, '.pages-dist')), code('ARTIFACT_DIRECTORY_NOT_ALLOWED'));
});

test('output 파일 누락을 검증에서 거부', async t => {
  const root = await fixture(t);
  await buildPages({ projectRoot: root });
  await rm(path.join(root, '.pages-dist', 'style.css'));
  await assert.rejects(verifyPagesArtifact(path.join(root, '.pages-dist')), code('ARTIFACT_FILE_SET_MISMATCH'));
});

test('path traversal/absolute/Windows 경로를 거부', () => {
  for (const input of ['../index.html', '/index.html', 'C:/index.html', '..\\index.html',
    './index.html', 'dir//index.html', 'app.js:stream', '']) {
    assert.throws(() => validateFrontendAssetPath(input), code('INVALID_ASSET_PATH'));
  }
});

test('allowlist 밖의 정상 relative path도 거부', () => {
  for (const input of ['worker/src/index.js', '.env', '.dev.vars', 'scripts/build-pages.mjs', 'README.md']) {
    assert.throws(() => validateFrontendAssetPath(input), code('ASSET_NOT_ALLOWED'));
  }
});

test('stale 산출물과 중첩 비공개 파일은 다음 build에서 제거', async t => {
  const root = await fixture(t);
  await buildPages({ projectRoot: root });
  await mkdir(path.join(root, '.pages-dist', 'worker', 'migrations'), { recursive: true });
  await writeFile(path.join(root, '.pages-dist', 'worker', 'migrations', 'stale.sql'), 'stale');
  await writeFile(path.join(root, '.pages-dist', '.env'), '실제 비밀 없는 stale 표식');
  const result = await buildPages({ projectRoot: root });
  assert.deepEqual(result.assets.map(row => row.path), EXPECTED);
  assert(!(await readdir(root)).some(name => name.startsWith('.pages-dist-build-') || name.startsWith('.pages-dist-backup-')));
});

test('동일 source의 반복 build는 deterministic hash 유지', async t => {
  const root = await fixture(t);
  const first = await buildPages({ projectRoot: root });
  const second = await buildPages({ projectRoot: root });
  assert.deepEqual(second, first);
});

test('source 변경은 해당 공개 산출물만 갱신', async t => {
  const root = await fixture(t);
  const first = await buildPages({ projectRoot: root });
  await writeFile(path.join(root, 'style.css'), '/* 새로운 공개 테스트 CSS */');
  const second = await buildPages({ projectRoot: root });
  assert.deepEqual(second.assets.filter(row => row.path !== 'style.css'), first.assets.filter(row => row.path !== 'style.css'));
  assert.notEqual(second.assets.find(row => row.path === 'style.css').sha256, first.assets.find(row => row.path === 'style.css').sha256);
});

test('missing source 실패 시 기존 정상 output은 보존', async t => {
  const root = await fixture(t);
  const before = await buildPages({ projectRoot: root });
  await rm(path.join(root, 'app.js'));
  await assert.rejects(buildPages({ projectRoot: root }), code('SOURCE_MISSING'));
  const retained = await verifyPagesArtifact(path.join(root, '.pages-dist'));
  assert.deepEqual(retained.assets, before.assets);
});

test('source symlink/junction을 거부하며 외부 대상은 보존', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  // Windows에서는 관리자 symlink 권한 없이도 생성 가능한 directory junction으로 동일 차단 정책을 검증한다.
  await rm(path.join(root, 'app.js'));
  await symlink(outside, path.join(root, 'app.js'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildPages({ projectRoot: root }), code('SYMLINK_REJECTED'));
  assert.equal((await readdir(outside)).length, 10);
});

test('output root junction/symlink를 거부하며 대상은 삭제하지 않음', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await symlink(outside, path.join(root, '.pages-dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildPages({ projectRoot: root }), code('UNSAFE_DIRECTORY'));
  assert.equal((await readdir(outside)).length, 10);
});

test('stale output 내부 junction/symlink는 따라가거나 정리하지 않음', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await buildPages({ projectRoot: root });
  await symlink(outside, path.join(root, '.pages-dist', 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildPages({ projectRoot: root }), code('SYMLINK_REJECTED'));
  assert.equal((await readdir(outside)).length, 10);
});

test('content mismatch 검증과 production equality helper는 network 없이 정확한 bytes 비교', async t => {
  const root = await fixture(t);
  await buildPages({ projectRoot: root });
  assert.equal(compareAssetBytes(Buffer.from('same\r\n'), Buffer.from('same\r\n')).exact, true);
  assert.equal(compareAssetBytes(Buffer.from('same\r\n'), Buffer.from('same\n')).exact, false);
  await writeFile(path.join(root, '.pages-dist', 'index.html'), '소스와 다른 내용');
  await assert.rejects(verifyPagesArtifact(path.join(root, '.pages-dist'), { sourceRoot: root }), code('ARTIFACT_CONTENT_MISMATCH'));
});

test('Pages 명령은 dedicated output만 사용하고 기존 test script는 불변', () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json')));
  assert.equal(pkg.scripts['build:pages'], 'node scripts/build-pages.mjs');
  assert.equal(pkg.scripts['pages:dev'], 'npm run build:pages && wrangler pages dev .pages-dist');
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.js');
  const ignore = readFileSync(path.join(repo, '.gitignore'), 'utf8');
  assert(ignore.split(/\r?\n/).includes('.pages-dist/'));
});
