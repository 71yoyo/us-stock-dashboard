import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// 테스트 oracle은 승인 checkpoint의 실제 코드다. import 경로만 data URL/현지 파일 URL로 치환한다.
// 원문 코드 파일을 repo에 복제하거나 현재 구현을 reference로 재사용하지 않는다.
const referenceCheckpoint='607f93f2d7d7a2dbdb5684cf63db77987fdaf4be';
let reference;
export async function loadHistoricalReferenceRuntime() {
  if(reference)return reference;
  const original=file=>execFileSync('git',['show',`${referenceCheckpoint}:${file}`],{encoding:'utf8'});
  const url=file=>pathToFileURL(resolve(file)).href;
  const data=code=>`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  const store=original('worker/src/sec-standard-raw-store.js')
    .replace("'./sec-standard-raw.js'",JSON.stringify(url('worker/src/sec-standard-raw.js')));
  const runtime=original('worker/src/sec-standard-raw-incremental.js')
    .replace("'./sec-standard-raw.js'",JSON.stringify(url('worker/src/sec-standard-raw.js')))
    .replace("'./sec-standard-raw-store.js'",JSON.stringify(data(store)))
    .replace("'./sec-raw-runtime-policy.js'",JSON.stringify(url('worker/src/sec-raw-runtime-policy.js')));
  reference=(await import(data(runtime))).runRawRecordRuntime;
  return reference;
}

/** wall-clock/token만 제외한다. 값/출처/fence/attempt/review/accession/실제 날짜는 비교에서 제거하지 않는다. */
export function historicalSemanticSnapshot(sqlite) {
  const omit=new Set(['created_at','updated_at','completed_at','raw_last_success_at','next_run_at','lease_token','lease_until']);
  return Object.fromEntries(['sec_standard_raw_metrics','sec_standard_raw_provenance','sec_raw_runtime','sec_raw_payload_checkpoint','sec_raw_runtime_guard']
    .map(table=>[table,sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
      .map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!omit.has(key))))]));
}
