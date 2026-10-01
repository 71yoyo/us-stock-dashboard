import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

// 변경 파일만 검사한다. 실제 값은 메모리에서 비교하고 값/길이/일부 문자열도 로그에 남기지 않는다.
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
const files = [...new Set([...git(['diff', '--name-only']), ...git(['ls-files', '--others', '--exclude-standard'])])];
const values = [];
for (const directory of ['.', 'worker']) for (const name of readdirSync(directory).filter(name => /^\.dev\.vars(?:\.|$)|^\.env(?:\.|$)/.test(name))) {
  if (name.endsWith('.example')) continue;
  const text = readFileSync(`${directory}/${name}`, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);
    if (!match || !/KEY|TOKEN|SECRET|PIN|USER_AGENT|CREDENTIAL/.test(match[1])) continue;
    const value = match[2].replace(/^['"]|['"]$/g, '');
    if (value.length >= 6) values.push(value);
  }
}
for (const file of files) {
  assert.ok(!/\.dev\.vars|\.env(?:\.|$)|\.pdf$|\.png$|\.sqlite$|\.db$/i.test(file), '변경 대상에 민감/원문 파일이 있습니다.');
  const text = readFileSync(file, 'utf8');
  assert.ok(values.every(value => !text.includes(value)), `민감정보 발견: ${file}`);
  assert.ok(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text), `실제 이메일 후보 발견: ${file}`);
}
console.log(JSON.stringify({ filesChecked: files.length, sensitiveValuesPrinted: false, sensitiveInformationIncluded: false }));
