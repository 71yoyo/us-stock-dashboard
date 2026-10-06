import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// R11A에서 실측한 10개와 같은 고정 목록이다. Git ignore나 재귀적인 소스 복사를 공개 경계로 사용하지 않는다.
// 공개 파일을 추가할 때는 이 선언·frontend graph·테스트를 함께 검토한다.
export const FRONTEND_ASSETS = Object.freeze([
  'app.js',
  'cloudflare-config.js',
  'financial-chart.js',
  'fundamental-progress.css',
  'fundamental-progress.js',
  'index.html',
  'reit-financial-chart.js',
  'style.css',
  'tradingview-widget.js',
  'williams-signal.js'
]);
export const PAGES_OUTPUT_DIRECTORY = '.pages-dist';
const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

class PagesBuildError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requireCondition(condition, code, message) {
  if (!condition) throw new PagesBuildError(code, message);
}

export function validateFrontendAssetPath(relativePath) {
  requireCondition(typeof relativePath === 'string' && relativePath.length > 0,
    'INVALID_ASSET_PATH', '프런트엔드 파일 경로가 필요합니다.');
  requireCondition(!path.isAbsolute(relativePath) && !relativePath.includes('\\') &&
    !relativePath.includes(':') && relativePath.split('/').every(part => part && part !== '.' && part !== '..'),
  'INVALID_ASSET_PATH', '절대 경로·상위 경로·역슬래시 경로는 공개할 수 없습니다.');
  requireCondition(FRONTEND_ASSETS.includes(relativePath), 'ASSET_NOT_ALLOWED',
    '프런트엔드 allowlist에 없는 파일은 공개할 수 없습니다.');
  return relativePath;
}

async function statOrNull(target) {
  try { return await lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function requireDirectory(target) {
  const stat = await statOrNull(target);
  requireCondition(stat && !stat.isSymbolicLink() && stat.isDirectory(),
    'UNSAFE_DIRECTORY', '실제 디렉터리만 사용할 수 있습니다. symlink/junction은 제거해 주세요.');
  return realpath(target);
}

// 심볼릭 링크·junction·특수 파일을 따라가지 않는다. output 내부의 빈 추가 디렉터리도 검사한다.
async function inventory(directory, prefix = '') {
  const files = [];
  const directories = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute);
    requireCondition(!stat.isSymbolicLink(), 'SYMLINK_REJECTED', 'symlink/junction은 빌드 입력·산출물에서 허용하지 않습니다.');
    if (stat.isDirectory()) {
      directories.push(relative);
      const nested = await inventory(absolute, relative);
      files.push(...nested.files);
      directories.push(...nested.directories);
    } else {
      requireCondition(stat.isFile(), 'REGULAR_FILE_REQUIRED', '일반 파일만 공개할 수 있습니다.');
      files.push(relative);
    }
  }
  return { files: files.sort(), directories: directories.sort() };
}

// lstat 이후 바뀐 입력도 가능한 범위에서 차단한다. 읽은 bytes를 그대로 복사하여 줄바꿈을 변경하지 않는다.
async function readRegularFile(root, relative) {
  validateFrontendAssetPath(relative);
  const target = path.join(root, relative);
  const stat = await statOrNull(target);
  requireCondition(stat, 'SOURCE_MISSING', `필수 프런트엔드 파일이 없습니다: ${relative}`);
  requireCondition(!stat.isSymbolicLink(), 'SYMLINK_REJECTED', `symlink 입력을 사용할 수 없습니다: ${relative}`);
  requireCondition(stat.isFile(), 'REGULAR_FILE_REQUIRED', `일반 파일이 아닙니다: ${relative}`);
  requireCondition(path.relative(root, await realpath(target)) === relative.split('/').join(path.sep),
    'UNSAFE_SOURCE_PATH', '소스 파일이 프로젝트 밖을 참조합니다.');
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await file.stat();
    requireCondition(opened.isFile() && opened.dev === stat.dev && opened.ino === stat.ino,
      'SOURCE_CHANGED', '검사 도중 소스 파일이 변경됐습니다. 빌드를 다시 실행해 주세요.');
    return await file.readFile();
  } finally { await file.close(); }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function compareAssetBytes(localBytes, remoteBytes) {
  const localSha256 = sha256(localBytes);
  const remoteSha256 = sha256(remoteBytes);
  return { exact: localSha256 === remoteSha256, localSha256, remoteSha256 };
}

export async function verifyPagesArtifact(directory, { sourceRoot } = {}) {
  const root = await requireDirectory(path.resolve(directory));
  const found = await inventory(root);
  requireCondition(found.files.length === FRONTEND_ASSETS.length &&
    found.files.every((file, index) => file === FRONTEND_ASSETS[index]),
  'ARTIFACT_FILE_SET_MISMATCH', '산출물 파일 목록이 정확한 프런트엔드 allowlist와 다릅니다.');
  requireCondition(found.directories.every(dir => FRONTEND_ASSETS.some(file => file.startsWith(`${dir}/`))),
    'ARTIFACT_DIRECTORY_NOT_ALLOWED', 'allowlist와 무관한 디렉터리가 산출물에 있습니다.');
  const assets = [];
  for (const relative of found.files) {
    const bytes = await readRegularFile(root, relative);
    if (sourceRoot) {
      const original = await readRegularFile(sourceRoot, relative);
      requireCondition(compareAssetBytes(bytes, original).exact,
        'ARTIFACT_CONTENT_MISMATCH', `소스와 산출물 내용이 다릅니다: ${relative}`);
    }
    assets.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return { fileCount: assets.length, unexpected: 0, assets };
}

// 삭제는 명시적으로 생성된 sibling 디렉터리에 한정한다. root/source 경로나 symlink는 삭제하지 않는다.
async function removeGeneratedDirectory(projectRoot, target) {
  const absolute = path.resolve(target);
  requireCondition(path.dirname(absolute) === projectRoot &&
    /^\.pages-dist-(build|backup)-[A-Za-z0-9-]+$/.test(path.basename(absolute)),
  'UNSAFE_CLEANUP_TARGET', '생성 디렉터리 밖의 삭제는 금지합니다.');
  if (!await statOrNull(absolute)) return;
  requireCondition(await requireDirectory(absolute) === absolute,
    'UNSAFE_CLEANUP_TARGET', '삭제 대상의 실제 경로가 생성 경로와 다릅니다.');
  await inventory(absolute);
  await rm(absolute, { recursive: true });
}

export async function buildPages({ projectRoot = DEFAULT_PROJECT_ROOT } = {}) {
  const root = await requireDirectory(path.resolve(projectRoot));
  const output = path.join(root, PAGES_OUTPUT_DIRECTORY);
  requireCondition(path.dirname(output) === root, 'UNSAFE_OUTPUT_PATH', '출력은 프로젝트의 전용 생성 디렉터리여야 합니다.');
  const sources = [];
  for (const relative of FRONTEND_ASSETS) sources.push([relative, await readRegularFile(root, relative)]);
  const old = await statOrNull(output);
  if (old) {
    await requireDirectory(output);
    await inventory(output);
  }
  const staging = await mkdtemp(path.join(root, '.pages-dist-build-'));
  const previous = path.join(root, `.pages-dist-backup-${randomUUID()}`);
  let oldMoved = false;
  let published = false;
  try {
    for (const [relative, bytes] of sources) {
      const destination = path.join(staging, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: 'wx' });
    }
    await verifyPagesArtifact(staging, { sourceRoot: root });
    if (old) { await rename(output, previous); oldMoved = true; }
    await rename(staging, output);
    published = true;
    const result = await verifyPagesArtifact(output, { sourceRoot: root });
    if (oldMoved) await removeGeneratedDirectory(root, previous);
    return { output: PAGES_OUTPUT_DIRECTORY, ...result };
  } catch (error) {
    // 교체 실패 시 기존 정상 산출물을 복원한다. 새 artifact가 남더라도 CLI는 실패하여 deploy가 진행될 수 없다.
    if (oldMoved && !published && !await statOrNull(output)) await rename(previous, output);
    throw error;
  } finally {
    if (!published) await removeGeneratedDirectory(root, staging);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({ status: 'PASS', ...await buildPages() })); }
  catch (error) {
    console.error(JSON.stringify({ status: 'FAIL', code: error.code || 'BUILD_FAILED',
      message: error instanceof PagesBuildError ? error.message : 'Pages 빌드에 실패했습니다. 파일 상태와 권한을 확인해 주세요.' }));
    process.exitCode = 1;
  }
}
