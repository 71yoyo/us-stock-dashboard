// 일시 네트워크 오류에만 최대 2회 backoff를 허용한다. 의미 충돌·hash·lease·constraint 오류는 재시도하지 않는다.
export function retryable(error) {
  const message = String(error.message);
  if (/충돌|정의 변경|hash.*mismatch|lease|constraint|SAFETY/i.test(message)) return false;
  return /network|fetch failed|overloaded|temporarily unavailable/i.test(message);
}
export async function boundedRetry(operation, sleep = ms => new Promise(done => setTimeout(done, ms)), random = Math.random) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(attempt); }
    catch (error) { if (attempt >= 2 || !retryable(error)) throw error; await sleep(200 * 2 ** attempt + Math.floor(random() * 100)); }
  }
}
