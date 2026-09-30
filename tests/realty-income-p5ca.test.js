import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { p5caDocument, p5caFixture, p5caResults } from './helpers/realty-income-p5ca-fixtures.js';
import { pdfFingerprint, FORMATS } from '../worker/src/reit/realty-income-document-formats.js';
import { parseRealtyIncomePdfText, extractRealtyIncomePdfStructure } from '../worker/src/reit/realty-income-pdf-parser.js';
import { parseRealtyIncomeDocument } from '../worker/src/reit/realty-income-document-adapter.js';
import { shareLayout } from '../worker/src/reit/realty-income-structural-strategy.js';
import { assertP5caRegression, STRUCTURAL_CANDIDATE_IDS, DEFERRED_DOCUMENT_IDS } from '../scripts/realty-income-p5ca-regression.mjs';
import { auditDocument, summarize, deduplicate, comparisons } from '../scripts/realty-income-p5b-core.mjs';
import { metricRecordKey } from '../worker/src/specialized-metrics.js';
import { saveSpecializedMetrics, readSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { createMetricTestDatabase, seedProtectedMetrics, protectedDigest } from './helpers/specialized-metrics-db.js';

const all = p5caResults();
const parse = async document => parseRealtyIncomePdfText(document, pdfFingerprint(document.excerpt));
const rowAt = async id => (await all).find(row => row.id === id);

for (const id of STRUCTURAL_CANDIDATE_IDS) test(`P5C-A 실제 후보 ${id}: 구조 판별과 정의 승인 별도`, async () => {
  const document = await p5caDocument(id), detection = pdfFingerprint(document.excerpt), row = await rowAt(id);
  assert.equal(detection.format, FORMATS.structuralLegacy);
  assert.ok(detection.structural_strategy);
  if (id === '2023-q4') {
    assert.equal(row.final_status, 'NEEDS_REVIEW'); assert.equal(row.structure_status, 'parsed');
    assert.equal(row.definition_status, 'needs_review'); assert.equal(row.errors[0].code, 'DEFINITION_REVIEW');
    assert.deepEqual(row.records, []); assert.deepEqual(row.definitions, []);
  } else {
    assert.equal(row.final_status, 'PARSED');
    assert.ok(row.records.every(record => record.validation_status === 'parsed'));
  }
});

for (const sample of p5caFixture('official-expected').samples) test(`P5C-A 수동 PDF official expected ${sample.id}`, async () => {
  const document = await p5caDocument(sample.id), detection = pdfFingerprint(document.excerpt);
  const { observations } = extractRealtyIncomePdfStructure(document, detection), row = await rowAt(sample.id);
  for (const period of sample.periods) for (const [metric,values] of Object.entries(period).filter(([key]) => key !== 'scope')) {
    for (const [index,[basis,share]] of [['total','not_applicable'],['per_share','diluted']].entries()) {
      const matches = observations.filter(value => value.fiscal_year === document.source.fiscal_year && value.period_scope === period.scope
        && value.metric_code === metric && value.value_basis === basis && value.share_basis === share);
      assert.equal(matches.length, 1); assert.equal(matches[0].raw_value, values[index]);
      assert.ok(sample.pages.includes(matches[0].page.page_number));
      if (sample.mode === 'canonical') {
        const record = row.records.find(value => value.fiscal_year === document.source.fiscal_year && value.period_scope === period.scope
          && value.metric_code === metric && value.value_basis === basis && value.share_basis === share);
        assert.equal(record.raw_value, values[index]); assert.equal(record.canonical_value, values[index] * (index ? 1 : 1000));
        assert.equal(record.canonical_unit, index ? 'USD/share' : 'USD');
      } else assert.deepEqual(row.records, []); // 읽힌 공시행의 일치는 정의 승인/validated 승격이 아니다.
    }
  }
});

test('P5C-A 수동 expected 68개 중 56 canonical / 12 structure-only, 신규 자동 validated 없음', async () => {
  const samples = p5caFixture('official-expected').samples;
  const count = subset => subset.reduce((sum,item) => sum + item.periods.reduce((n,period) => n + (Object.keys(period).length - 1) * 2,0),0);
  assert.equal(count(samples),68); assert.equal(count(samples.filter(row => row.mode === 'canonical')),56);
  for (const id of STRUCTURAL_CANDIDATE_IDS) assert.ok((await rowAt(id)).records.every(row => row.validation_status === 'parsed'));
});

test('P5C-A diluted total 미공시 및 NFFO 미공시는 역산하지 않음', async () => {
  for (const id of ['2016-q1','2017-q3']) {
    const row = await rowAt(id);
    assert.ok(row.records.every(value => value.metric_code !== 'NORMALIZED_FFO' && !(value.value_basis === 'total' && value.share_basis === 'diluted')));
    assert.equal(row.availability.filter(value => value.share_basis === 'diluted').length,2);
  }
});
test('P5C-A metric별 반대 joint/separate 조합을 parser 복제 없이 처리', async () => {
  for (const [id,layouts] of [['2018-q2',{FFO:'separate',NORMALIZED_FFO:'absent',AFFO:'joint_basic_diluted'}],
    ['2021-q4',{FFO:'joint_basic_diluted',NORMALIZED_FFO:'separate',AFFO:'separate'}],
    ['2023-q2',{FFO:'separate',NORMALIZED_FFO:'joint_basic_diluted',AFFO:'separate'}],
    ['2023-q4',{FFO:'separate',NORMALIZED_FFO:'separate',AFFO:'separate'}]]) {
    assert.deepEqual((await rowAt(id)).structural_strategy.share_layouts,layouts);
  }
});
test('P5C-A joint basic/diluted canonical key 별개, source observation/provenance 공동', async () => {
  for (const id of ['2016-q1','2018-q1','2019-q4','2021-q1','2023-q2']) {
    const row = await rowAt(id);
    for (const basic of row.records.filter(value => value.value_basis === 'per_share' && value.share_basis === 'basic'
      && value.sources[0].source_basis === 'joint_basic_diluted')) {
      const diluted = row.records.find(value => value.metric_code === basic.metric_code && value.period_start === basic.period_start
        && value.period_end === basic.period_end && value.share_basis === 'diluted' && value.value_basis === 'per_share');
      assert.equal(basic.canonical_value,diluted.canonical_value); assert.notEqual(metricRecordKey(basic),metricRecordKey(diluted));
      assert.deepEqual(basic.sources,diluted.sources);
    }
  }
});
test('P5C-A 명시적 Basic and Diluted 하위행 두 basis와 원 label 보존', async () => {
  const row = await rowAt('2019-q4');
  const shares = row.records.filter(value => value.metric_code === 'FFO' && value.value_basis === 'per_share');
  assert.equal(shares.length,8);
  assert.ok(shares.every(value => value.sources[0].section === 'FFO per common share / Basic and Diluted'
    && value.sources[0].source_basis === 'joint_basic_diluted'));
});
test('P5C-A joint 행에 별도 conflicting basis가 있으면 차단', async () => {
  const document = await p5caDocument('2019-q4');
  document.excerpt.pages[0].text = document.excerpt.pages[0].text.replace('Basic and Diluted $ 0.85 $ 0.73 $ 3.29 $ 3.12',
    'Basic and Diluted $ 0.85 $ 0.73 $ 3.29 $ 3.12\nBasic $ 0.84 $ 0.73 $ 3.29 $ 3.12');
  assert.throws(() => pdfFingerprint(document.excerpt),error => error.code === 'BASIS_AMBIGUITY');
});
test('P5C-A joint label이 애매하거나 누락되면 주식수로 대체하지 않음', async () => {
  const document = await p5caDocument('2019-q4');
  document.excerpt.pages[0].text = document.excerpt.pages[0].text.replace('Basic and Diluted $','Basic or Diluted $');
  const result=await parse(document); assert.equal(result.status,'needs_review'); assert.equal(result.errors[0].code,'BASIS_AMBIGUITY');
  assert.deepEqual(result.records,[]);
});
test('P5C-A blank separator로 공동행 뒤 conflicting basis 검사를 우회할 수 없음', async () => {
  const document=await p5caDocument('2019-q4');
  document.excerpt.pages[0].text=document.excerpt.pages[0].text.replace('Basic and Diluted $ 0.85 $ 0.73 $ 3.29 $ 3.12',
    'Basic and Diluted $ 0.85 $ 0.73 $ 3.29 $ 3.12\n\nBasic $ 0.84 $ 0.73 $ 3.29 $ 3.12');
  assert.throws(()=>pdfFingerprint(document.excerpt),error=>error.code==='BASIS_AMBIGUITY');
});
test('P5C-A 공동행 숫자 열 수 불일치 차단', async () => {
  const document = await p5caDocument('2019-q4');
  document.excerpt.pages[0].text = document.excerpt.pages[0].text.replace('Basic and Diluted $ 0.85 $ 0.73 $ 3.29 $ 3.12','Basic and Diluted $ 0.85 $ 0.73 $ 3.29');
  const result = await parse(document); assert.equal(result.status,'needs_review'); assert.equal(result.errors[0].code,'VALUE_AMBIGUITY');
});
test('P5C-A 공동행 중복 label 차단', async () => {
  const document = await p5caDocument('2018-q1'),page=document.excerpt.pages[0];
  const line=page.text.split('\n').find(value => value.startsWith('FFO per common share, basic and diluted'));
  page.text=page.text.replace(line,`${line}\n${line}`);
  assert.throws(() => pdfFingerprint(document.excerpt),error => error.code === 'BASIS_AMBIGUITY');
});
test('P5C-A Q1 economic period는 quarterly만 생성, YTD duplicate 없음', async () => {
  for (const id of STRUCTURAL_CANDIDATE_IDS.filter(id => id.endsWith('q1'))) {
    const row=await rowAt(id); assert.ok(row.records.every(value => value.period_scope === 'quarterly'));
    assert.equal(new Set(row.records.map(metricRecordKey)).size,row.records.length);
  }
});
test('P5C-A 실제 Q2 6M/Q3 9M scope는 별도이며 quarterly 차감 계산 없음', async () => {
  for (const id of ['2018-q2','2017-q3','2023-q2']) {
    const row=await rowAt(id); assert.deepEqual([...new Set(row.records.map(value => value.period_scope))],['quarterly','ytd']);
    assert.ok(row.records.filter(value => value.period_scope === 'ytd').every(value => value.period_start.endsWith('-01-01')));
  }
});
test('P5C-A Q4 standalone와 FY 공시 scope 분리', async () => {
  for (const id of ['2019-q4','2020-q4','2021-q4','2022-q4']) {
    const row=await rowAt(id); assert.deepEqual([...new Set(row.records.map(value => value.period_scope))],['quarterly','annual']);
    assert.ok(row.records.filter(value => value.period_scope === 'quarterly').every(value => value.period_start.endsWith('-10-01')));
    assert.ok(row.records.filter(value => value.period_scope === 'annual').every(value => value.period_start.endsWith('-01-01') && value.fiscal_period === 'FY'));
  }
});
test('P5C-A 실제 기간 열 순서/연도가 다르면 차단', async () => {
  const document=await p5caDocument('2018-q2'); document.excerpt.pages[0].text=document.excerpt.pages[0].text.replace('2018 2017 2018 2017','2017 2018 2017 2018');
  assert.equal((await parse(document)).errors[0].code,'PERIOD_AMBIGUITY');
});
test('P5C-A 명확한 세 unit grammar에서 total ×1000 / per-share ×1', async () => {
  for (const id of ['2016-q1','2021-q4','2023-q2']) {
    const row=await rowAt(id);
    for(const value of row.records) assert.equal(value.canonical_value,value.raw_value*(value.value_basis === 'total'?1000:1));
    assert.ok(row.records.every(value => value.sources[0].weighted_share_count_raw_unit === (id==='2023-q2'?'shares thousand':'shares')));
  }
});
test('P5C-A weighted shares는 원 단위만 보존하고 metric 계산에 사용하지 않음', async () => {
  const document=await p5caDocument('2023-q2'),original=await parse(document);
  for(const page of document.excerpt.pages) page.text=page.text.replace('Basic 674,109 601,672 667,357 597,778','Basic 1 2 3 4').replace('Diluted 676,388 603,091 669,903 599,201','Diluted 5 6 7 8');
  const changed=await parse(document); assert.equal(changed.status,'parsed');
  assert.deepEqual(changed.records.map(value => [metricRecordKey(value),value.canonical_value]),original.records.map(value => [metricRecordKey(value),value.canonical_value]));
});
test('P5C-A unaudited suffix / 현대 USD grammar / millions 지원 금지', async () => {
  for(const unit of ['(in thousands, except per share amounts) (unaudited)','(USD and shares in thousands, except per share amounts)','(in millions, except per share amounts)']) {
    const document=await p5caDocument('2023-q2'); document.excerpt.pages[0].text=document.excerpt.pages[0].text.replace('(in thousands, except per share amounts)',unit);
    assert.throws(() => pdfFingerprint(document.excerpt),error => error.code==='UNIT_UNKNOWN');
  }
});
test('P5C-A definition mismatch는 structure parsed이나 값/정의 생성 없음', async () => {
  const row=await rowAt('2023-q4'); assert.equal(row.structure_status,'parsed'); assert.equal(row.definition_status,'needs_review'); assert.equal(row.records.length,0);
  const document=await p5caDocument('2023-q2'); document.excerpt.definition_excerpts=document.excerpt.definition_excerpts.map(page => ({...page,text:page.text.replace('our merger with VEREIT.','our merger with VEREIT and Spirit.')}));
  assert.equal((await parse(document)).errors[0].code,'DEFINITION_REVIEW');
});
test('P5C-A 정의 근거 누락은 신규 version 생성/연도 inference 금지', async () => {
  const document=await p5caDocument('2023-q2'); document.excerpt.definition_excerpts=[];
  const result=await parse(document); assert.equal(result.status,'needs_review'); assert.equal(result.errors[0].code,'DEFINITION_UNKNOWN'); assert.equal(result.records.length,0);
});
for (const id of DEFERRED_DOCUMENT_IDS) test(`P5C-A 의도적 제외 ${id} 차단 유지`, async () => {
  const row=await rowAt(id); assert.ok(['NEEDS_REVIEW','UNKNOWN_FORMAT'].includes(row.final_status)); assert.equal(row.records.length,0);
});
test('P5C-A 기존 17개 format/records/definitions/provenance/status SHA256 완전 동일', async () => {
  assert.deepEqual(assertP5caRegression(await all,p5caFixture('p5b-regression')),{baseline_documents:17,full_deep_equality:false,deferred_documents:8});
});
test('P5C-A regression guard는 값/정의/출처/상태 변경과 제외 문서 승격 차단', async () => {
  for(const mutate of [row=>row.records[0].canonical_value++,row=>row.records[0].sources[0].section='잘못된 출처',row=>row.definitions[0].definition_version='변경',row=>row.final_status='NEEDS_REVIEW']) {
    const rows=structuredClone(await all); mutate(rows.find(row=>row.id==='2016-q2'));
    assert.throws(()=>assertP5caRegression(rows,p5caFixture('p5b-regression')),/REGRESSION BLOCKER/);
  }
  const rows=structuredClone(await all); rows.find(row=>row.id==='2025-q1').final_status='PARSED';
  assert.throws(()=>assertP5caRegression(rows,p5caFixture('p5b-regression')),/REGRESSION BLOCKER/);
});
test('P5C-A full 40 offline audit 상태/coverage 재계산', async () => {
  const summary=summarize(await all); assert.deepEqual(summary.statuses,{VERIFIED_PARSED:9,PARSED:22,NEEDS_REVIEW:3,UNKNOWN_FORMAT:6,WRONG_ISSUER:0,SOURCE_UNAVAILABLE:0,PARSER_ERROR:0});
  for(const metric of ['FFO','AFFO']) {
    assert.equal(summary.quarterly.metrics[metric]['total/not_applicable'],31); assert.equal(summary.quarterly.metrics[metric]['per_share/diluted'],31);
    assert.equal(summary.annual.metrics[metric]['total/not_applicable'],6); assert.equal(summary.annual.metrics[metric]['per_share/diluted'],6);
  }
  assert.equal(summary.quarterly.metrics.NORMALIZED_FFO['total/not_applicable'],11);
  assert.equal(summary.annual.metrics.NORMALIZED_FFO['per_share/diluted'],2);
  assert.equal(summary.quarterly.metrics.NORMALIZED_FFO.confirmed_reported_opportunities,19);
  assert.equal(summary.annual.metrics.NORMALIZED_FFO.confirmed_reported_opportunities,5);
});
test('P5C-A 952 observations → 658 unique / 952 provenance, comparison 294 exact / conflict 0', async () => {
  const rows=await all,merged=deduplicate(rows),comparison=comparisons(rows);
  assert.equal(merged.observations,952); assert.equal(merged.unique_values,658); assert.equal(merged.provenance,952); assert.deepEqual(merged.conflicts,[]);
  assert.equal(comparison.comparable,294); assert.equal(comparison.exact_match,294); assert.equal(comparison.difference,0);
});
test('P5C-A 합성 conflicting canonical 값은 자동 overwrite 하지 않음', async () => {
  const original=await rowAt('2018-q1'),later=structuredClone(await rowAt('2019-q1'));
  later.records.find(value=>value.fiscal_year===2018).canonical_value+=1000;
  const merged=deduplicate([original,later]); assert.equal(merged.conflicts.length,1); assert.equal(merged.conflicts[0].overwrite,false);
});
test('P5C-A 신규 audit 문서는 production 승인 manifest에 자동 추가되지 않음', async () => {
  assert.equal((await parseRealtyIncomeDocument(await p5caDocument('2016-q1'))).status,'needs_review');
});
test('P5C-A wrong issuer는 새로운 구조라도 차단', async () => {
  const fixture=p5caFixture('2018-q2'); fixture.inspection.identity_text='VEREIT (NYSE: VER)';
  assert.equal((await auditDocument(fixture.inventory,fixture.inspection)).final_status,'WRONG_ISSUER');
});
test('P5C-A fixture는 최소 JSON뿐, 원문 PDF/QA/OCR/cache 파일 없음', () => {
  const names=readdirSync(new URL('./fixtures/realty-income-p5ca/',import.meta.url)); assert.ok(names.every(name=>name.endsWith('.json')));
  for(const name of names) assert.ok(readFileSync(new URL(`./fixtures/realty-income-p5ca/${name}`,import.meta.url)).length<18000);
});
test('P5C-A 구조 strategy에는 source 연도/티커/expected 값 분기 없음', () => {
  const text=readFileSync(new URL('../worker/src/reit/realty-income-structural-strategy.js',import.meta.url),'utf8').replace(/\/\/[^\n]*/g,'');
  assert.ok(!/fiscal_year|\bticker\b|expected|\b20(?:16|17|18|19|20|21|22|23|24|25)\b/.test(text));
  assert.equal(shareLayout({text:'AFFO per common share\nBasic $ 1 $ 2\nDiluted $ 1 $ 2'},'AFFO'),'separate');
});
for (const fresh of [true,false]) test(`P5C-A 0018 ${fresh?'Fresh':'Existing'} 메모리 DB round-trip, 보호 digest 불변`, async () => {
  const {sqlite,DB}=createMetricTestDatabase(fresh);
  try {
    seedProtectedMetrics(sqlite); const before=protectedDigest(sqlite);
    if(!fresh) sqlite.exec(readFileSync(new URL('../worker/migrations/0018_company_specialized_metrics.sql',import.meta.url),'utf8'));
    const rows=(await all).filter(row=>['PARSED','VERIFIED_PARSED'].includes(row.final_status));
    for(const row of rows) {
      const result={status:'parsed',definitions:row.definitions,records:row.records};
      await saveSpecializedMetrics(DB,result); await saveSpecializedMetrics(DB,result);
    }
    const records=await readSpecializedMetrics(DB,'O');
    assert.equal(records.length,658); assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_sources').get().n,952);
    assert.equal(protectedDigest(sqlite),before);
    const joint=records.filter(value=>value.sources.some(source=>source.source_basis==='joint_basic_diluted'));
    assert.ok(joint.length>0); assert.ok(joint.every(value=>value.sources.some(source=>source.structural_features)));
    assert.equal(records.filter(value=>value.validation_status==='validated').length,162);
    const reviewed=await parse(await p5caDocument('2023-q4'));
    await assert.rejects(saveSpecializedMetrics(DB,reviewed),/저장/);
    assert.equal((await readSpecializedMetrics(DB,'O')).length,658);
  } finally { sqlite.close(); }
});
