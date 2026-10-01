import { execFileSync } from 'node:child_process';

// 로컬 문법 검사만 실행한다. 원격 인증/preview 생성/backup upload는 포함하지 않는다.
for (const path of ['scripts/p77-query-worker.js', 'scripts/p77-gate-core.mjs',
  'scripts/p77-runtime-audit.mjs', 'scripts/p77-cpu-evidence.mjs', 'scripts/p77-check.mjs', 'tests/p77-gate.test.js']) {
  execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
}
console.log('P7.7 문법 검사 PASS');
