import { execFileSync } from 'node:child_process';

// 검사 명령은 네트워크/원격 write/승인 artifact 생성 없이 문법만 확인한다.
for(const path of ['scripts/specialized-d1-admin.mjs','scripts/specialized-import-safety.mjs',
  'scripts/specialized-import-coordination.mjs','scripts/specialized-production-import.mjs',
  'scripts/specialized-release-policy.mjs',
  'scripts/specialized-classification-backfill.mjs','worker/src/classification-backfill.js',
  'scripts/p76-readonly-audit.mjs','scripts/p76-remote-rehearsal.mjs','scripts/p76-query-preview.mjs',
  'scripts/p76-query-worker.js','tests/specialized-import-coordination.test.js'])
  execFileSync(process.execPath,['--check',path],{stdio:'pipe'});
console.log('P7.6 문법 검사 PASS');
