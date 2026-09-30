import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { p5caDocument, p5caFixture, p5caResults } from './helpers/realty-income-p5ca-fixtures.js';
import { historicalDocument } from './helpers/realty-income-historical-fixtures.js';
import { p5aDocument } from './helpers/realty-income-p5a-fixtures.js';
import { p5cb1Expected, p5cb1Results } from './helpers/realty-income-p5cb1-fixtures.js';
import { pdfFingerprint } from '../worker/src/reit/realty-income-document-formats.js';
import { historicalDefinitions } from '../worker/src/reit/realty-income-normalizer.js';
import { parseRealtyIncomeDocument } from '../worker/src/reit/realty-income-document-adapter.js';
import { parseRealtyIncomePdfText } from '../worker/src/reit/realty-income-pdf-parser.js';
import { parseReviewedRealtyIncomePdf, reviewDefinitionSemantics, reconciliationCommonRow, SPIRIT_DEFINITIONS } from '../worker/src/reit/realty-income-definition-review.js';
import { REVIEW_IDS, MODERN_BLOCKED_IDS, auditReviewedDocument, assertP5cb1Regression } from '../scripts/realty-income-p5cb1-core.mjs';
import { summarize, deduplicate, comparisons } from '../scripts/realty-income-p5b-core.mjs';
import { metricRecordKey } from '../worker/src/specialized-metrics.js';
import { saveSpecializedMetrics, readSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { createMetricTestDatabase, seedProtectedMetrics, protectedDigest } from './helpers/specialized-metrics-db.js';

const original = p5caResults(), reviewed = p5cb1Results();
const parse = document => parseReviewedRealtyIncomePdf(document,pdfFingerprint(document.excerpt));
const reviewedRow = async id => (await reviewed).find(row=>row.id===id);
const versions = definitions => Object.fromEntries(definitions.map(row=>[row.metric_code,row.definition_version]));
const replaceDefinition = (document,from,to) => {
  assert.ok(document.excerpt.definition_excerpts.some(page=>page.text.includes(from)), '합성 테스트의 실제 변경 위치가 없습니다.');
  document.excerpt.definition_excerpts = document.excerpt.definition_excerpts.map(page=>({...page,text:page.text.replace(from,to)}));
};

for (const sample of p5cb1Expected().samples) test(`P5C-B1 ${sample.id} official expected 전체 basis/단위/기간`, async () => {
  const row=await reviewedRow(sample.id);
  assert.equal(row.final_status,'PARSED');
  for (const period of sample.periods) for (const [metric,values] of Object.entries(period).filter(([key])=>key!=='scope')) {
    for (const [index,[basis,share]] of [['total','not_applicable'],['total','diluted'],['per_share','basic'],['per_share','diluted']].entries()) {
      const matches=row.records.filter(value=>value.fiscal_year===sample.year && value.period_scope===period.scope
        && value.metric_code===metric && value.value_basis===basis && value.share_basis===share);
      assert.equal(matches.length,1); const value=matches[0];
      assert.equal(value.raw_value,values[index]); assert.equal(value.canonical_value,values[index]*(index<2?1000:1));
      assert.equal(value.raw_unit,index<2?'USD thousand':'USD/share'); assert.equal(value.canonical_unit,index<2?'USD':'USD/share');
      assert.ok(sample.pages.includes(value.sources[0].page_number));
      assert.equal(value.validation_status,'parsed');
      assert.equal(value.period_end,sample.id==='2021-q3'?'2021-09-30':`${sample.year}-12-31`);
      assert.equal(value.period_start,`${sample.year}-${period.scope==='quarterly'?(sample.id==='2021-q3'?'07':'10'):'01'}-01`);
    }
  }
});
test('P5C-B1 수동 expected 64개, comparison/YTD 자동 validated 승격 없음', async () => {
  assert.equal(p5cb1Expected().samples.reduce((n,s)=>n+s.periods.reduce((p,r)=>p+(Object.keys(r).length-1)*4,0),0),64);
  for (const id of REVIEW_IDS) assert.ok((await reviewedRow(id)).records.every(row=>row.validation_status==='parsed' && row.validation===null));
});
test('P5C-B1 2017 payout의 (less than)은 총액 행이 아니며 최종 AFFO만 추출', async () => {
  const document=await p5caDocument('2017-q4'),detection=pdfFingerprint(document.excerpt);
  assert.equal((await parseRealtyIncomePdfText(document,detection)).errors[0].code,'DUPLICATE_LABEL');
  const result=await parse(document); assert.equal(result.records.length,32);
  assert.ok(result.records.filter(row=>row.metric_code==='AFFO' && row.value_basis==='total' && row.share_basis==='not_applicable')
    .every(row=>row.sources[0].section==='Total AFFO available to common stockholders'));
  assert.equal(result.availability[0].metric_code,'NORMALIZED_FFO'); assert.equal(result.availability[0].status,'not_reported');
});
test('P5C-B1 duplicate selector는 앞/뒤 순서가 아닌 heading/이웃 역할에 의존', async () => {
  const document=await p5caDocument('2017-q4'),detection=pdfFingerprint(document.excerpt);
  const lines=detection.affo.text.split('\n').map(s=>s.trim()).filter(Boolean);
  const decoy='Total AFFO available to common stockholders $ 1 $ 2 $ 3 $ 4';
  const modified=[lines[0],decoy,...lines.slice(1),decoy];
  const found=reconciliationCommonRow({lines:modified,metric:'AFFO',label:'Total AFFO available to common stockholders',detection});
  assert.ok(found.line.includes('215,312')); assert.ok(found.index>1 && found.index<modified.length-1);
});
test('P5C-B1 중복 final 문맥 두 개/누락된 조정방향/heading 불일치는 차단', async () => {
  const document=await p5caDocument('2017-q4'),detection=pdfFingerprint(document.excerpt);
  const lines=detection.affo.text.split('\n').map(s=>s.trim()).filter(Boolean),i=lines.findIndex(line=>line.startsWith('Total AFFO available'));
  for (const changed of [[...lines,...lines.slice(i-1,i+3)],lines.filter(line=>!line.startsWith('Cumulative adjustments')),['Wrong heading',...lines.slice(1)]]) {
    assert.throws(()=>reconciliationCommonRow({lines:changed,metric:'AFFO',label:'Total AFFO available to common stockholders',detection}),e=>e.code==='RECONCILIATION_CONTEXT');
  }
});
test('P5C-B1 2017 실제 FFO/AFFO 기존 definition 재사용', async () => {
  assert.deepEqual(versions((await reviewedRow('2017-q4')).definitions),{FFO:'FFO-DEPRECIABLE-V1',AFFO:'AFFO-FFO-DEPRECIABLE-V1'});
});
test('P5C-B1 2021 proposed 제거는 정의 범위와 실제 비용 행이 같아 기존 버전 재사용', async () => {
  const q2=historicalDocument('q2-2021'),q3=await p5caDocument('2021-q3');
  assert.equal(reviewDefinitionSemantics(q2,pdfFingerprint(q2.excerpt)).decision,'same_vereit_merger');
  const review=reviewDefinitionSemantics(q3,pdfFingerprint(q3.excerpt));
  assert.equal(review.decision,'same_vereit_merger');
  assert.deepEqual(versions(review.definitions),versions(historicalDefinitions(q2.excerpt,pdfFingerprint(q2.excerpt))));
});
test('P5C-B1 2021 Q4 integration는 Q3와 실제 범위 차이, 기존 Q4 버전 수정 없음', async () => {
  const q4=await p5caDocument('2021-q4'),q3=await reviewedRow('2021-q3');
  const v4=versions(historicalDefinitions(q4.excerpt,pdfFingerprint(q4.excerpt)));
  assert.equal(v4.NORMALIZED_FFO,'NFFO-MERGER-INTEGRATION-V1');
  assert.notEqual(v4.NORMALIZED_FFO,versions(q3.definitions).NORMALIZED_FFO);
});
test('P5C-B1 2021 NFFO standalone와 9M YTD는 별도 identity이며 역산하지 않음', async () => {
  const row=await reviewedRow('2021-q3');
  const scopes=row.records.filter(v=>v.metric_code==='NORMALIZED_FFO' && v.fiscal_year===2021 && v.value_basis==='total' && v.share_basis==='not_applicable');
  assert.deepEqual(scopes.map(v=>[v.period_scope,v.raw_value]),[['quarterly',349118],['ytd',944498]]);
  assert.notEqual(metricRecordKey(scopes[0]),metricRecordKey(scopes[1]));
});
test('P5C-B1 2023 Q3/Q4/2024Q1 원문 비교: Spirit scope는 별도 버전', async () => {
  const q3=p5aDocument('2023-q3'),q1=await p5caDocument('2024-q1'),q4=await reviewedRow('2023-q4');
  const old3=versions(historicalDefinitions(q3.excerpt,pdfFingerprint(q3.excerpt)));
  const old1=versions(historicalDefinitions(q1.excerpt,pdfFingerprint(q1.excerpt)));
  assert.equal(old3.NORMALIZED_FFO,old1.NORMALIZED_FFO);
  assert.equal(old1.AFFO,'AFFO-NFFO-INTEGRATION-V1');
  assert.equal(versions(q4.definitions).NORMALIZED_FFO,SPIRIT_DEFINITIONS.NORMALIZED_FFO);
  assert.equal(versions(q4.definitions).AFFO,SPIRIT_DEFINITIONS.AFFO);
  assert.equal(versions(q4.definitions).FFO,old3.FFO);
  assert.ok(q4.records[0].sources[0].definition_evidence.affo_table.includes('Non-cash change in allowance for credit losses'));
});
for (const [id,from,to] of [
  ['2021-q3','our merger with VEREIT.','our merger with Unknown Corporation.'],
  ['2023-q4','VEREIT and Spirit.','VEREIT and Unknown Corporation.'],
  ['2023-q4','and integration-related costs associated','and unapproved transaction fees associated']
]) test(`P5C-B1 ${id} 미검토 제외 범위 ${to}는 format만 supported/정의 blocked`, async () => {
  const document=await p5caDocument(id); replaceDefinition(document,from,to);
  const result=await parse(document);
  assert.equal(result.format_status,'supported'); assert.equal(result.definition_status,'review'); assert.equal(result.value_status,'blocked');
  assert.deepEqual(result.records,[]); assert.deepEqual(result.definitions,[]);
});
for (const id of ['2021-q3','2023-q4']) test(`P5C-B1 ${id} glossary와 비용 행 불일치/추가 제외항목 차단`, async () => {
  for (const extra of [false,true]) {
    const document=await p5caDocument(id),label=id==='2021-q3'?'Merger-related costs':'Merger and integration-related costs';
    document.excerpt.pages[0].text=document.excerpt.pages[0].text.replace(label,extra?'Additional unknown costs 1 2 3 4\n'+label:'Unapproved costs');
    const result=await parse(document); assert.equal(result.definition_status,'review'); assert.equal(result.value_status,'blocked'); assert.equal(result.records.length,0);
  }
});
test('P5C-B1 정의 누락/모순 paragraph는 canonical 생성하지 않음', async () => {
  for (const duplicate of [false,true]) {
    const document=await p5caDocument('2021-q3');
    if (duplicate) {
      const paragraph=document.excerpt.definition_excerpts.find(page=>page.text.startsWith('Normalized Funds'));
      document.excerpt.definition_excerpts.push({...paragraph,text:paragraph.text.replace('VEREIT.','Unknown Corporation.')});
    } else document.excerpt.definition_excerpts=[];
    assert.equal((await parse(document)).records.length,0);
  }
});
test('P5C-B1 row 숫자 변경은 expected 기반 분기를 유발하지 않음', async () => {
  const document=await p5caDocument('2017-q4');
  document.excerpt.pages[1].text=document.excerpt.pages[1].text.replace('$ 215,312 $ 192,964','$ 215,313 $ 192,964');
  const result=await parse(document); assert.equal(result.status,'parsed');
  assert.equal(result.records.find(v=>v.metric_code==='AFFO' && v.period_scope==='quarterly' && v.fiscal_year===2017 && v.share_basis==='not_applicable').raw_value,215313);
});
test('P5C-B1 문서별 정의 원문/page/hash/기간 provenance 유지', async () => {
  for (const id of REVIEW_IDS) {
    const document=await p5caDocument(id),row=await reviewedRow(id);
    for (const record of row.records) {
      const source=record.sources[0];
      assert.equal(source.source_url,document.source.source_url); assert.equal(source.source_hash,document.source.source_hash);
      assert.equal(source.fiscal_year,document.source.fiscal_year); assert.equal(source.document_name,document.source.document_name);
      assert.match(source.input_hash,/^[a-f0-9]{64}$/); assert.equal(source.extraction_method,'pdf_text_no_ocr');
      assert.deepEqual(source.definition_evidence.paragraphs,document.excerpt.definition_excerpts);
      assert.ok(source.definition_evidence.ffo_table && source.definition_evidence.affo_table);
      assert.ok(source.definition_evidence.paragraphs.every(p=>p.page_number>0));
    }
  }
});
test('P5C-B1 새 definition의 metadata는 승인 출처 고정, 후속 문서 provenance와 분리', async () => {
  const document=await p5caDocument('2023-q4'),first=reviewDefinitionSemantics(document,pdfFingerprint(document.excerpt));
  document.source.source_url='https://www.realtyincome.com/public-followup.pdf';
  assert.deepEqual(reviewDefinitionSemantics(document,pdfFingerprint(document.excerpt)).definitions,first.definitions);
});
for (const id of MODERN_BLOCKED_IDS) test(`P5C-B1 ${id} modern 미지원 deep equality 유지`, async () => {
  const row=await reviewedRow(id),old=(await original).find(r=>r.id===id);
  assert.equal(row.final_status,'UNKNOWN_FORMAT'); assert.deepEqual(row.records,[]); assert.deepEqual(row,old);
});
test('P5C-B1 기존31 전체 결과 deep equality, 바뀔 수 있는 문서는 정확히3개', async () => {
  const old=await original,rows=await reviewed,baseline={checkpoint:'99592cc92a2fe08d33f84881f9e76643b06ae88f',rows:old.filter(r=>['PARSED','VERIFIED_PARSED'].includes(r.final_status))};
  assert.deepEqual(assertP5cb1Regression(rows,baseline,old),{protected_documents:31,full_deep_equality:true,modern_blocked:6});
  for (const mutate of [r=>r.records[0].canonical_value++,r=>r.definitions[0].definition_notes='변경',r=>r.records[0].sources[0].section='변경',r=>r.final_status='NEEDS_REVIEW']) {
    const broken=structuredClone(rows); mutate(broken.find(r=>r.id==='2016-q2'));
    assert.throws(()=>assertP5cb1Regression(broken,baseline,old),/REGRESSION BLOCKER/);
  }
});
test('P5C-B1 전체40 상태/quarterly/annual coverage 실제 재계산', async () => {
  const s=summarize(await reviewed);
  assert.deepEqual(s.statuses,{VERIFIED_PARSED:9,PARSED:25,NEEDS_REVIEW:0,UNKNOWN_FORMAT:6,WRONG_ISSUER:0,SOURCE_UNAVAILABLE:0,PARSER_ERROR:0});
  for (const metric of ['FFO','AFFO']) for (const basis of ['total/not_applicable','per_share/diluted']) {
    assert.equal(s.quarterly.metrics[metric][basis],34); assert.equal(s.annual.metrics[metric][basis],8);
  }
  for (const basis of ['total/not_applicable','per_share/diluted']) {
    assert.equal(s.quarterly.metrics.NORMALIZED_FFO[basis],13); assert.equal(s.annual.metrics.NORMALIZED_FFO[basis],3);
  }
});
test('P5C-B1 1080 observations/746 unique/1080 provenance, comparison334 exact/conflict0', async () => {
  const rows=await reviewed,d=deduplicate(rows),c=comparisons(rows);
  assert.equal(d.observations,1080); assert.equal(d.unique_values,746); assert.equal(d.provenance,1080); assert.deepEqual(d.conflicts,[]);
  assert.equal(c.exact_match,334); assert.equal(c.comparable,334); assert.equal(c.difference,0); assert.deepEqual(c.restated_candidates,[]);
});
test('P5C-B1 같은 period/value도 definition 다르면 별도 identity, 강제 dedup 없음', async () => {
  const record=(await reviewedRow('2023-q4')).records.find(r=>r.metric_code==='AFFO'),other=structuredClone(record);
  other.definition_version='AFFO-NFFO-INTEGRATION-V1';
  assert.notEqual(metricRecordKey(record),metricRecordKey(other));
  assert.equal(deduplicate([{final_status:'PARSED',records:[record,other]}]).unique_values,2);
});
test('P5C-B1 comparative 차이는 restatement candidate 보고하고 overwrite하지 않음', async () => {
  const earlier=structuredClone(await reviewedRow('2021-q3')),later=structuredClone(await reviewedRow('2022-q3'));
  later.records.find(r=>r.fiscal_year===2021 && r.metric_code==='FFO').canonical_value+=1000;
  const merged=deduplicate([earlier,later]),comparison=comparisons([earlier,later]);
  assert.equal(comparison.difference,1); assert.equal(comparison.restated_candidates.length,1);
  assert.equal(merged.conflicts.length,1); assert.equal(merged.conflicts[0].overwrite,false);
});
test('P5C-B1 wrong issuer는 새 review entry point 앞에서 차단', async () => {
  const fixture=p5caFixture('2021-q3'); fixture.inspection.identity_text='VEREIT (NYSE: VER)';
  const row=await auditReviewedDocument(fixture.inventory,fixture.inspection);
  assert.equal(row.final_status,'WRONG_ISSUER'); assert.equal(row.records.length,0);
});
test('P5C-B1 실제 production 승인 manifest/adapter는 확장하지 않음', async () => {
  for (const id of REVIEW_IDS) assert.notEqual((await parseRealtyIncomeDocument(await p5caDocument(id))).status,'parsed');
});
test('P5C-B1 신규 fixture는 최소 expected JSON뿐, 원문/cache/OCR없음', () => {
  const names=readdirSync(new URL('./fixtures/realty-income-p5cb1/',import.meta.url)); assert.deepEqual(names,['official-expected.json']);
  assert.ok(readFileSync(new URL('./fixtures/realty-income-p5cb1/official-expected.json',import.meta.url)).length<5000);
  const code=readFileSync(new URL('../worker/src/reit/realty-income-definition-review.js',import.meta.url),'utf8').replace(/\/\/[^\n]*/g,'');
  assert.ok(!/\bexpected\b|fiscal_year\s*[=!<>]|ticker\s*[=!<>]|switch\s*\(.*year/.test(code));
});
for (const fresh of [true,false]) test(`P5C-B1 0018 ${fresh?'Fresh':'Existing'} 새 정의 round-trip/기존 digest 불변`, async () => {
  const {sqlite,DB}=createMetricTestDatabase(fresh);
  try {
    seedProtectedMetrics(sqlite); const digest=protectedDigest(sqlite);
    if (!fresh) sqlite.exec(readFileSync(new URL('../worker/migrations/0018_company_specialized_metrics.sql',import.meta.url),'utf8'));
    for (const row of (await reviewed).filter(r=>['PARSED','VERIFIED_PARSED'].includes(r.final_status))) {
      const result={status:'parsed',records:row.records,definitions:row.definitions};
      await saveSpecializedMetrics(DB,result); await saveSpecializedMetrics(DB,result);
    }
    const records=await readSpecializedMetrics(DB,'O');
    assert.equal(records.length,746); assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_sources').get().n,1080);
    // full historical 8개 기존 의미 + Spirit 2개. P3 HTML의 6개 정의는 이 40 PDF 범위에 없다.
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_definitions').get().n,10);
    assert.equal(records.filter(r=>r.validation_status==='validated').length,162); assert.equal(protectedDigest(sqlite),digest);
    const spirit=records.find(r=>r.definition_version===SPIRIT_DEFINITIONS.AFFO);
    assert.ok(spirit.sources[0].definition_evidence.normalized_sentence.includes('Spirit'));
    const blocked=await p5caDocument('2023-q4'); replaceDefinition(blocked,'VEREIT and Spirit.','VEREIT and Unknown Corporation.');
    await assert.rejects(saveSpecializedMetrics(DB,await parse(blocked)),/저장/);
    const conflict=structuredClone(await reviewedRow('2023-q4')); conflict.records[0].raw_value++; conflict.records[0].canonical_value+=1000;
    await assert.rejects(saveSpecializedMetrics(DB,{status:'parsed',...conflict}),/충돌/);
    assert.equal((await readSpecializedMetrics(DB,'O')).length,746); assert.equal(protectedDigest(sqlite),digest);
  } finally {sqlite.close();}
});
