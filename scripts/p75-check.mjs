import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

// 새 검증 도구만 문법 검사한다. remote 접속이나 artifact 생성은 이 명령에서 실행하지 않는다.
for (const name of readdirSync('scripts').filter(name => name.startsWith('p75-') && /\.(mjs|js)$/.test(name))) {
  execFileSync(process.execPath, ['--check', `scripts/${name}`], { stdio: 'pipe' });
}
console.log('P7.5 검증 도구 문법: PASS');
