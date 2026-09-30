import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve,relative,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { p5cb2Results, modernExpected } from '../tests/helpers/realty-income-p5cb2-fixtures.js';
import { officialResults } from '../tests/helpers/realty-income-fixtures.js';
import { summarize } from './realty-income-p5b-core.mjs';
import { assertP5cb2Regression, MODERN_IDS } from './realty-income-p5cb2-core.mjs';
import { compareAnnualSources } from './realty-income-p5cb2-cross-source.mjs';

const args=process.argv.slice(2);
assert.ok(args.length===0||args.length===2&&args[0]==='--read-only-cache','로컬 fixture 또는 --read-only-cache만 허용합니다.');
let rows,regression;
if(args.length){
  const cache=resolve(args[1]),repo=fileURLToPath(new URL('..',import.meta.url));
  assert.ok(relative(repo,cache).startsWith('..'),'cache는 repo 밖이어야 합니다.');
  rows=JSON.parse(readFileSync(join(cache,'dry-run-results.json'),'utf8')).rows;
  regression=assertP5cb2Regression(rows,JSON.parse(readFileSync(join(cache,'p5cb1-regression-baseline.json'),'utf8')));
  for(const row of rows)assert.equal(createHash('sha256').update(readFileSync(join(cache,row.id+'.pdf'))).digest('hex'),row.source_hash);
}else{
  rows=await p5cb2Results();
  const frozen=JSON.parse(readFileSync(new URL('../tests/fixtures/realty-income-p5cb2/regression-digests.json',import.meta.url),'utf8'));
  for(const row of frozen.rows)assert.equal(createHash('sha256').update(JSON.stringify(rows.find(r=>r.id===row.id))).digest('hex'),row.sha256);
  regression={protected_documents:frozen.rows.length,full_deep_equality:true};
}
let expectedCount=0;
for(const sample of modernExpected().samples){
  const document=rows.find(row=>row.id===sample.id);assert.equal(document.final_status,'PARSED');
  for(const period of sample.periods)for(const metric of ['FFO','NORMALIZED_FFO','AFFO'])
    for(const [index,[basis,share]]of [['total','not_applicable'],['total','diluted'],['per_share','basic'],['per_share','diluted']].entries()){
      const found=document.records.filter(row=>row.metric_code===metric&&row.fiscal_year===sample.year
        &&row.period_scope===period.scope&&row.value_basis===basis&&row.share_basis===share);
      assert.equal(found.length,1);assert.equal(found[0].raw_value,period[metric][index]);
      assert.equal(found[0].canonical_value,period[metric][index]*(index<2?1000:1));expectedCount++;
    }
}
assert.equal(expectedCount,132);
const annual=rows.find(row=>row.id==='2025-q4'),sec=(await officialResults())[0];
const cross=compareAnnualSources({status:'parsed',records:annual.records,definitions:annual.definitions},sec);
assert.equal(cross.exact,12);assert.equal(cross.difference,0);
const summary=summarize(rows);
// 공개 source metadata와 통계만 출력한다. 원문/secret/DB backfill payload는 만들지 않는다.
console.log(JSON.stringify({scope:'read-only; persistence/production approval unchanged',
  input:args.length?'external verified cache':'offline minimal fixtures',regression,
  official_expected:{checked:expectedCount,pass:expectedCount,fail:0},
  cross_source:{compared:cross.compared,exact:cross.exact,difference:cross.difference,conflict:cross.conflict,automatic_merge:false},
  summary,modern_documents:rows.filter(row=>MODERN_IDS.includes(row.id)).map(row=>({id:row.id,status:row.final_status,
    format:row.detected_format,source_url:row.source_url,source_hash:row.source_hash,records:row.records.length,
    definitions:row.definitions.map(d=>d.definition_version),unit:row.unit_audit,table_fingerprint:row.table_fingerprint,
    table_identity:row.structural_strategy}))},null,2));
