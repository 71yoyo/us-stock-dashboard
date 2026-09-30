import { spawn } from 'node:child_process';

// 운영 실행을 강제하지 않고 기존 Wrangler tail에서 자연 발생한 이벤트만 관찰한다.
// 요청 본문·헤더·로그 메시지·예외 메시지는 비밀값이 섞일 수 있어 출력하지 않는다.
const child = spawn(process.execPath, ['--use-system-ca', 'node_modules/wrangler/bin/wrangler.js',
  'tail', 'us-stock-dashboard-api', '--config', 'worker/wrangler.jsonc', '--format', 'json'],
{ stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let buffer = '';
let foundScheduled = false;
let stopping = false;
const timer = setTimeout(() => stop('관찰 시간 만료'), 330_000);

function stop(reason) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  console.log(JSON.stringify({ observerStopped: reason, foundScheduled }));
  child.kill();
}

function emitEvent(event) {
  if (!event.outcome) return;
  const cron = event.event?.cron || null;
  console.log(JSON.stringify({ outcome: event.outcome, cron,
    scheduledTime: event.event?.scheduledTime || null,
    eventTimestamp: event.eventTimestamp || null,
    exceptions: (event.exceptions || []).map(exception => ({ name: exception.name || 'Error' })) }));
  if (cron === '1-59/5 * * * *') {
    foundScheduled = true;
    stop('fundamental Cron의 자연 실행 확인');
  }
}

// 예쁘게 출력된 여러 JSON 객체를 분리한다. 따옴표 안의 중괄호는 경계로 취급하지 않는다.
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (start < 0) {
      if (character === '{') { start = index; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    if (depth === 0) {
      try { emitEvent(JSON.parse(buffer.slice(start, index + 1))); }
      catch { console.log(JSON.stringify({ observerWarning: '이벤트 JSON 해석 실패 · 원문 비공개' })); }
      buffer = buffer.slice(index + 1);
      index = -1;
      start = -1;
    }
  }
  if (buffer.length > 2_000_000) buffer = '';
});
child.stderr.on('data', () => { /* Wrangler 오류 원문 대신 종료 상태만 진단한다. */ });
child.on('error', () => stop('관찰 프로세스 시작 실패'));
child.on('exit', code => {
  clearTimeout(timer);
  console.log(JSON.stringify({ observerExitCode: code, foundScheduled }));
});
process.on('SIGINT', () => stop('사용자 또는 작업 종료'));
