import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// 명시적으로 승인된 inventory의 40개 IR PDF만 한 번씩 읽는다. 재시도/DB/Secret/운영 API 경로는 없다.
if (process.argv.slice(2).join(' ') !== '--read-only-download') throw new Error('--read-only-download 명시가 필요합니다.');
const inventory = JSON.parse(readFileSync(new URL('../tests/fixtures/realty-income-p5a/inventory.json', import.meta.url), 'utf8')).documents;
if (inventory.length !== 40 || new Set(inventory.map(row => `${row.year}-Q${row.quarter}`)).size !== 40) throw new Error('40개 고유 inventory가 아닙니다.');
const cache = mkdtempSync(join(tmpdir(), 'stock-phase-p5b-'));
if (!relative(fileURLToPath(new URL('..', import.meta.url)), resolve(cache)).startsWith('..')) throw new Error('cache는 repo 밖이어야 합니다.');
console.log(`CACHE ${cache}`);
const sources = [];
for (const row of inventory) {
  const id = `${row.year}-q${row.quarter}`, entry = { id, year: row.year, quarter: row.quarter, source_url: row.source_url,
    retrieved_at: new Date().toISOString(), http_status: null, final_url: null, source_hash: null, bytes: null, error: null };
  try {
    const url = new URL(row.source_url);
    if (url.protocol !== 'https:' || url.hostname !== 'www.realtyincome.com' || url.search || url.username || url.password) throw new Error('inventory의 공식 IR URL만 허용합니다.');
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
    entry.http_status = response.status; entry.final_url = response.url;
    const final = new URL(response.url);
    if (final.protocol !== 'https:' || final.hostname !== 'www.realtyincome.com') throw new Error('비공식 redirect를 차단했습니다.');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 20000000 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('PDF magic/크기 검증 실패');
    entry.source_hash = createHash('sha256').update(bytes).digest('hex'); entry.bytes = bytes.length;
    writeFileSync(join(cache, `${id}.pdf`), bytes, { flag: 'wx' });
  } catch (error) { entry.error = error.message; }
  sources.push(entry);
  writeFileSync(join(cache, 'sources.json'), JSON.stringify({ cache, inventory_count: 40, sources }, null, 2));
  console.log(`${id} ${entry.error ? 'SOURCE_UNAVAILABLE ' + entry.error : 'HTTP ' + entry.http_status + ' SHA ' + entry.source_hash.slice(0, 12)}`);
  // IR에 병렬 요청 폭주를 피한다. SEC 요청은 하지 않는다.
  await new Promise(resolve => setTimeout(resolve, 300));
}
console.log(`COMPLETE ${sources.length} / 접근 성공 ${sources.filter(row => !row.error).length}`);
