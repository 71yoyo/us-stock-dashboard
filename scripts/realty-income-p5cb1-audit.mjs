import assert from 'node:assert/strict';
import { p5cb1Expected, p5cb1Results } from '../tests/helpers/realty-income-p5cb1-fixtures.js';
import { p5caResults } from '../tests/helpers/realty-income-p5ca-fixtures.js';
import { officialResults } from '../tests/helpers/realty-income-fixtures.js';
import { assertP5cb1Regression } from './realty-income-p5cb1-core.mjs';
import { summarize } from './realty-income-p5b-core.mjs';
import { saveSpecializedMetrics, readSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { createMetricTestDatabase, seedProtectedMetrics, protectedDigest } from '../tests/helpers/specialized-metrics-db.js';
import { metricRecordKey } from '../worker/src/specialized-metrics.js';

// 최소 fixture 및 메모리 DB만 사용한다. 다운로드/환경변수/운영 설정 인수를 받지 않는다.
if (process.argv.length!==2) throw new Error('인수 없는 offline definition 검증만 지원합니다.');
const rows=await p5cb1Results(), original=await p5caResults();
const regression=assertP5cb1Regression(rows,{checkpoint:'99592cc92a2fe08d33f84881f9e76643b06ae88f',
  rows:original.filter(row=>['PARSED','VERIFIED_PARSED'].includes(row.final_status))},original);
let expectedCount=0;
for (const sample of p5cb1Expected().samples) for (const period of sample.periods) {
  const row=rows.find(row=>row.id===sample.id);
  for (const [metric,values] of Object.entries(period).filter(([key])=>key!=='scope')) {
    for (const [index,[basis,share]] of [['total','not_applicable'],['total','diluted'],['per_share','basic'],['per_share','diluted']].entries()) {
      const record=row.records.find(record=>record.fiscal_year===sample.year && record.period_scope===period.scope
        && record.metric_code===metric && record.value_basis===basis && record.share_basis===share);
      assert.equal(record.raw_value,values[index]); assert.equal(record.canonical_value,values[index]*(index<2?1000:1)); expectedCount++;
    }
  }
}
assert.equal(expectedCount,64);
const summary=summarize(rows),{sqlite,DB}=createMetricTestDatabase();
try {
  seedProtectedMetrics(sqlite); const digest=protectedDigest(sqlite);
  const p3=await officialResults();
  for (const result of p3) await saveSpecializedMetrics(DB,result);
  const p3Keys=new Set(p3.flatMap(result=>result.records.map(metricRecordKey)));
  const frozenP3=await readSpecializedMetrics(DB,'O');
  for (const row of rows.filter(row=>['PARSED','VERIFIED_PARSED'].includes(row.final_status))) {
    const result={status:'parsed',records:row.records,definitions:row.definitions};
    await saveSpecializedMetrics(DB,result); await saveSpecializedMetrics(DB,result);
  }
  const stored=await readSpecializedMetrics(DB,'O');
  assert.equal(stored.length,842); assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_sources').get().n,1176);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_definitions').get().n,16);
  assert.equal(stored.filter(row=>row.validation_status==='validated').length,198);
  assert.deepEqual(stored.filter(row=>p3Keys.has(metricRecordKey(row))),frozenP3);
  assert.equal(protectedDigest(sqlite),digest);
  console.log(JSON.stringify({expected:{count:expectedCount,pass:64,fail:0},regression,summary,
    combined_p3_roundtrip:{records:842,definitions:16,provenance:1176,validated:198,parsed:644,
      p3_unchanged:true,protected_digest_unchanged:true},production:'변경 없음'},null,2));
} finally {sqlite.close();}
