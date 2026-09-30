import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { modernFixture, modernInspections, modernExpected, p5cb2Results } from './helpers/realty-income-p5cb2-fixtures.js';
import { p5cb1Results } from './helpers/realty-income-p5cb1-fixtures.js';
import { officialResults } from './helpers/realty-income-fixtures.js';
import { modernTableUnit } from '../worker/src/reit/realty-income-modern-units.js';
import { parseModernRealtyIncomePdf, modernPdfFingerprint, INTEGRATED_FORMAT } from '../worker/src/reit/realty-income-modern-pdf.js';
import { parseRealtyIncomeDocument } from '../worker/src/reit/realty-income-document-adapter.js';
import { excerptHash } from '../worker/src/reit/realty-income-document-formats.js';
import { assertP5cb2Regression } from '../scripts/realty-income-p5cb2-core.mjs';
import { summarize, deduplicate } from '../scripts/realty-income-p5b-core.mjs';
import { compareAnnualSources, reviewedAnnualProvenanceView } from '../scripts/realty-income-p5cb2-cross-source.mjs';
import { saveSpecializedMetrics, readSpecializedMetrics } from '../worker/src/specialized-metric-store.js';
import { createMetricTestDatabase, seedProtectedMetrics, protectedDigest } from './helpers/specialized-metrics-db.js';

const rows=p5cb2Results(),oldRows=p5cb1Results();
const review=JSON.parse(readFileSync(new URL('./fixtures/realty-income-p5cb2/cross-source-review.json',import.meta.url),'utf8'));
const parse=async id=>parseModernRealtyIncomePdf(await modernFixture(id));
const bases=[['total','not_applicable'],['total','diluted'],['per_share','basic'],['per_share','diluted']];
const rehash=async document=>{document.source.excerpt_hash=await excerptHash(document.excerpt);return document;};
const assertBlocked=async(document,code)=>{const result=await parseModernRealtyIncomePdf(await rehash(document));
  assert.equal(result.records.length,0);assert.equal(result.definitions.length,0);assert.equal(result.errors[0].code,code);};

for(const sample of modernExpected().samples)for(const metric of ['FFO','NORMALIZED_FFO','AFFO'])
  test(`P5C-B2 ${sample.id} ${metric} 공식 expected/원 단위/기간/basis`,async()=>{
    const result=await parse(sample.id);assert.equal(result.status,'parsed');
    for(const period of sample.periods)for(const [index,[basis,share]] of bases.entries()){
      const found=result.records.filter(row=>row.metric_code===metric&&row.fiscal_year===sample.year
        &&row.period_scope===period.scope&&row.value_basis===basis&&row.share_basis===share);
      assert.equal(found.length,1);const row=found[0],expected=period[metric][index];
      assert.equal(row.raw_value,expected);assert.equal(row.canonical_value,expected*(index<2?1000:1));
      assert.equal(row.raw_unit_multiplier,index<2?1000:1);assert.equal(row.raw_unit,index<2?'USD thousand':'USD/share');
      assert.equal(row.validation_status,'parsed');assert.equal(row.validation,null);
      const quarter=Number(sample.id.at(-1));
      assert.equal(row.period_start,`${sample.year}-${period.scope==='quarterly'?String(quarter*3-2).padStart(2,'0'):'01'}-01`);
      assert.equal(row.period_end,`${sample.year}-${['03-31','06-30','09-30','12-31'][quarter-1]}`);
    }
  });

test('P5C-B2 수동 expected 132건만 대조하며 comparison을 자동 validated로 승격하지 않음',async()=>{
  assert.equal(modernExpected().samples.reduce((sum,sample)=>sum+sample.periods.length*12,0),132);
  for(const inspection of modernInspections())assert.ok((await parse(inspection.id)).records.every(row=>row.validation_status==='parsed'));
});
for(const identifier of ['2024-q3','2024-q4','2025-q1','2025-q2','2025-q3','2025-q4'])
  test(`P5C-B2 ${identifier} measurement/qualifier/총액/주당/주식수 단위 분리`,async()=>{
    const document=await modernFixture(identifier),unit=modernTableUnit(document.excerpt.pages[0]);
    assert.equal(unit.qualifier,'unaudited');assert.equal(unit.monetary_multiplier,1000);assert.equal(unit.per_share_multiplier,1);
    assert.equal(unit.weighted_shares,'shares thousand');
    assert.equal(unit.measurement,identifier.startsWith('2024')?'in thousands, except per share amounts':'USD and shares in thousands, except per share amounts');
  });
for(const suffix of ['(audited)','(restated)','(unaudited) (unknown)','(estimate)'])
  test(`P5C-B2 미검토 qualifier ${suffix} 차단`,async()=>{
    const document=await modernFixture('2024-q3');document.excerpt.pages[0].text=document.excerpt.pages[0].text.replace('(unaudited)',suffix);
    await assertBlocked(document,'UNIT_UNKNOWN');
  });
test('P5C-B2 qualifier 없는 동일 measurement도 단위 identity 유지',async()=>{
  const page=(await modernFixture('2024-q3')).excerpt.pages[0];page.text=page.text.replace(' (unaudited)','');
  const unit=modernTableUnit(page);assert.equal(unit.qualifier,null);assert.equal(unit.monetary,'USD thousand');
});
for(const [from,to] of [['USD and shares in thousands','EUR and shares in thousands'],['thousands','millions'],['($) ($) ($) ($)','($) ($) (EUR) ($)']])
  test(`P5C-B2 통화/배율 ambiguity ${to} 차단`,async()=>{
    const document=await modernFixture('2025-q2');document.excerpt.pages[0].text=document.excerpt.pages[0].text.replace(from,to);
    await assertBlocked(document,'UNIT_UNKNOWN');
  });
test('P5C-B2 두 metric의 단위 불일치 차단',async()=>{
  const document=await modernFixture('2024-q3');document.excerpt.pages[0].text=document.excerpt.pages[0].text.replace(' (unaudited)','');
  await assertBlocked(document,'UNIT_UNKNOWN');
});
test('P5C-B2 integrated 형식은 연도가 아닌 제목/unit/table fingerprint로 식별',async()=>{
  const document=await modernFixture('2025-q2'),detected=await modernPdfFingerprint(document.excerpt,document.source);
  assert.equal(detected.format,INTEGRATED_FORMAT);assert.match(detected.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(detected.structural_strategy.document_family,'integrated_earnings_supplemental');
  assert.ok(detected.structural_strategy.excluded_candidates.some(page=>page.role==='appendix'));
  document.source.fiscal_year++;document.excerpt.document_title=document.excerpt.document_title.replaceAll('2025','2026');
  document.excerpt.pages=document.excerpt.pages.map(page=>({...page,text:page.text.replaceAll('2024','2023').replaceAll('2025','2024')
    .replaceAll('2023','2025').replaceAll('2024','2026')}));
  document.excerpt.footnotes=document.excerpt.footnotes.map(page=>({...page,text:page.text.replaceAll('2025','2026')}));
  // 합성 문서의 연도만 이동한다. 공시값은 그대로이고 승인 분기는 연도를 열거하지 않는다.
  const result=await parseModernRealtyIncomePdf(await rehash(document));assert.equal(result.status,'parsed');assert.equal(result.format,INTEGRATED_FORMAT);
});
test('P5C-B2 2024는 불필요한 새 format 없이 structural strategy 재사용',async()=>{
  for(const id of ['2024-q3','2024-q4'])assert.equal((await parse(id)).format,'REALTY_INCOME_PDF_STRUCTURAL_LEGACY');
});
test('P5C-B2 candidate 입력 순서는 대표 표 identity를 바꾸지 않음',async()=>{
  const document=await modernFixture('2025-q2'),original=await parseModernRealtyIncomePdf(document);
  document.excerpt.pages.reverse();const result=await parseModernRealtyIncomePdf(await rehash(document));
  assert.equal(result.status,'parsed');assert.deepEqual(result.records.map(r=>r.canonical_value),original.records.map(r=>r.canonical_value));
});
test('P5C-B2 release/appendix의 반복값은 대표 표로 선택하지 않음',async()=>{
  const document=await modernFixture('2025-q2');
  const release={...document.excerpt.pages[0],page_number:10,text:document.excerpt.pages[0].text.replace(/Q2 2025 Supplemental Operating & Financial Data 15/,'Earnings Release 10')};
  const appendix={...document.excerpt.pages[1],page_number:61,text:document.excerpt.pages[1].text.replace(/^\(1\)\nAFFO/,'Appendix (Continued)\nAFFO')};
  document.excerpt.pages.unshift(release);document.excerpt.pages.push(appendix);
  const result=await parseModernRealtyIncomePdf(await rehash(document));assert.equal(result.status,'parsed');assert.equal(result.records.length,48);
  assert.deepEqual([...new Set(result.records.map(r=>r.sources[0].physical_page))],[33,34]);
});
test('P5C-B2 두 대표 후보는 동일값이어도 차단',async()=>{
  const document=await modernFixture('2025-q2');document.excerpt.pages.push({...document.excerpt.pages[0],page_number:36});
  await assertBlocked(document,'TABLE_AMBIGUITY');
});
test('P5C-B2 integrated AFFO 이어지는 각주 누락/다른 페이지/잘못된 참조는 차단',async()=>{
  for(const mutate of [d=>{d.excerpt.footnotes=[];},d=>{d.excerpt.footnotes[0].page_number++;},
    d=>{d.excerpt.footnotes[0].text=d.excerpt.footnotes[0].text.replace('reconciling items for Normalized FFO','unrelated table');}]){
    const document=await modernFixture('2025-q2');mutate(document);await assertBlocked(document,'TABLE_AMBIGUITY');
  }
});
test('P5C-B2 source가 가리키는 표 페이지 불일치 차단',async()=>{
  const document=await modernFixture('2025-q2');document.source.ffo_page++;await assertBlocked(document,'TABLE_AMBIGUITY');
});
for(const [from,to] of [['Q2 2025 Supplemental','Q3 2025 Supplemental'],['Three months ended June 30,','Six months ended June 30,'],['2025 2024 2025 2024','2024 2025 2024 2025']])
  test(`P5C-B2 모호/불일치 기간 ${to}는 partial numeric 없음`,async()=>{
    const document=await modernFixture('2025-q2');document.excerpt.pages[0].text=document.excerpt.pages[0].text.replace(from,to);
    await assertBlocked(document,'PERIOD_AMBIGUITY');
  });
test('P5C-B2 물리/printed page는 별도 보존하며 기존 page_number는 물리 page',async()=>{
  const expected={'2025-q1':[[32,15],[33,16]],'2025-q2':[[33,15],[34,16]],'2025-q3':[[33,15],[34,16]],'2025-q4':[[34,16],[35,17]]};
  for(const [id,pages]of Object.entries(expected))for(const row of (await parse(id)).records){
    const source=row.sources[0],pair=pages[row.metric_code==='AFFO'?1:0];
    assert.equal(source.page_number,pair[0]);assert.equal(source.physical_page,pair[0]);assert.equal(source.printed_page,pair[1]);
    assert.equal(source.unit_qualifier,'unaudited');assert.match(source.table_fingerprint,/^[a-f0-9]{64}$/);
    assert.ok(source.definition_evidence.footnotes.length===1);
  }
});
test('P5C-B2 share layout은 metric별로 독립 판정',async()=>{
  const layouts={'2025-q1':['joint_basic_diluted','joint_basic_diluted','separate'],
    '2025-q2':['joint_basic_diluted','joint_basic_diluted','joint_basic_diluted'],
    '2025-q3':['joint_basic_diluted','separate','separate'],'2025-q4':['separate','separate','separate']};
  for(const [id,expected]of Object.entries(layouts))assert.deepEqual(Object.values((await parse(id)).structural_strategy.share_layouts),expected);
});
test('P5C-B2 explicit joint subrow strategy도 기존 추출 경로 재사용',async()=>{
  const document=await modernFixture('2025-q2');
  document.excerpt.pages[0].text=document.excerpt.pages[0].text.replace('FFO per common share, basic and diluted 1.06','FFO per common share:\nBasic and Diluted 1.06');
  const result=await parseModernRealtyIncomePdf(await rehash(document));assert.equal(result.status,'parsed');
  assert.equal(result.structural_strategy.share_layouts.FFO,'joint_basic_diluted_subrow');
});
test('P5C-B2 주당행 뒤 conflicting basis는 차단',async()=>{
  const document=await modernFixture('2025-q2');document.excerpt.pages[0].text=document.excerpt.pages[0].text.replace('Normalized FFO per common share,','Basic 1 2 3 4\nNormalized FFO per common share,');
  await assertBlocked(document,'BASIS_AMBIGUITY');
});
test('P5C-B2 Q1 3M은 quarterly 하나이며 YTD 복제 없음',async()=>{
  assert.equal((await parse('2025-q1')).records.length,24);assert.ok((await parse('2025-q1')).records.every(r=>r.period_scope==='quarterly'));
});
test('P5C-B2 gross/net는 새 정의, 이후 placement fee/조정금액 변화는 새 버전 없음',async()=>{
  const gross=await parse('2024-q3'),net=await parse('2024-q4');
  assert.equal(gross.definitions[1].definition_version,'NFFO-MERGER-TRANSACTION-OTHER-V1');
  assert.equal(net.definitions[1].definition_version,'NFFO-MERGER-TRANSACTION-OTHER-NET-V1');
  for(const id of ['2025-q1','2025-q2','2025-q3','2025-q4'])assert.deepEqual((await parse(id)).definitions,net.definitions);
  assert.equal(gross.definitions[0].definition_version,net.definitions[0].definition_version);
});
for(const mutate of [d=>{d.excerpt.definition_excerpts[2].text=d.excerpt.definition_excerpts[2].text.replace('other costs','unknown costs');},
  d=>{d.excerpt.pages[0].text=d.excerpt.pages[0].text.replace('Merger, transaction, and other costs, net','Additional unapproved costs');},
  d=>{d.excerpt.pages[1].text=d.excerpt.pages[1].text.replace('Debt-related non-cash items:','Unknown exclusion 1 2 3 4');}])
  test('P5C-B2 미승인 정의/제외 범위는 숫자 없이 보류',async()=>{const document=await modernFixture('2025-q2');mutate(document);await assertBlocked(document,'DEFINITION_REVIEW');});
test('P5C-B2 원문 hash/발췌 hash mismatch는 rejected',async()=>{
  for(const field of ['source_hash','excerpt_hash']){const document=await modernFixture('2025-q2');document.source[field]='0'.repeat(64);
    const result=await parseModernRealtyIncomePdf(document);assert.equal(result.status,'rejected');assert.equal(result.errors[0].code,'SOURCE_HASH_MISMATCH');assert.equal(result.records.length,0);}
});
test('P5C-B2 다른 issuer/VEREIT는 합병 문맥과 구별해서 차단',async()=>{
  const document=await modernFixture('2025-q2');document.excerpt.identity_text='VEREIT (NYSE: VER)';await assertBlocked(document,'wrong_issuer');
});
test('P5C-B2 numeric 변경은 expected 기반 parsing이 아니라 직접 공시행 추출',async()=>{
  const document=await modernFixture('2025-q2');document.excerpt.pages[1].text=document.excerpt.pages[1].text.replace('Diluted AFFO 949,892','Diluted AFFO 949,893');
  const result=await parseModernRealtyIncomePdf(await rehash(document));assert.equal(result.status,'parsed');
  assert.equal(result.records.find(r=>r.metric_code==='AFFO'&&r.fiscal_year===2025&&r.period_scope==='quarterly'&&r.value_basis==='total'&&r.share_basis==='diluted').raw_value,949893);
});
test('P5C-B2 FY2025 SEC/IR 12/12 exact, 원본 정의와 record 불변',async()=>{
  const pdf=await parse('2025-q4'),sec=(await officialResults())[0],before=JSON.stringify([pdf,sec]);
  const comparison=compareAnnualSources(pdf,sec);assert.equal(comparison.compared,12);assert.equal(comparison.exact,12);assert.equal(comparison.difference,0);
  assert.equal(comparison.automatic_merge,false);assert.equal(JSON.stringify([pdf,sec]),before);
});
test('P5C-B2 cross-source difference는 CONFLICT/overwrite 없음',async()=>{
  const pdf=await parse('2025-q4'),sec=(await officialResults())[0];pdf.records.find(r=>r.fiscal_year===2025&&r.period_scope==='annual').canonical_value++;
  assert.equal(compareAnnualSources(pdf,sec).conflict,1);assert.throws(()=>reviewedAnnualProvenanceView(pdf,sec,review),/CONFLICT/);
});
test('P5C-B2 의미 검토 없는 numeric equality만으로 source 병합 금지',async()=>{
  const pdf=await parse('2025-q4'),sec=(await officialResults())[0];assert.throws(()=>reviewedAnnualProvenanceView(pdf,sec,{...review,approved:false}));
});
test('P5C-B2 0018 JSON metadata: FY 12 canonical/24 provenance round-trip, 기존 numeric/classification 불변',async()=>{
  const pdf=await parse('2025-q4'),sec=(await officialResults())[0],view=reviewedAnnualProvenanceView(pdf,sec,review);
  const {sqlite,DB}=createMetricTestDatabase();
  try{seedProtectedMetrics(sqlite);const before=protectedDigest(sqlite);
    await saveSpecializedMetrics(DB,view);await saveSpecializedMetrics(DB,view);
    const stored=await readSpecializedMetrics(DB,'O');assert.equal(stored.length,12);assert.ok(stored.every(row=>row.sources.length===2));
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM company_metric_sources').get().n,24);
    for(const row of stored){const source=row.sources.find(s=>s.source_type==='ISSUER_IR_PDF');assert.equal(source.physical_page,source.page_number);
      assert.ok(source.printed_page<source.physical_page);assert.ok(source.original_definition_version&&source.definition_equivalence_review.approved);}
    assert.equal(protectedDigest(sqlite),before);
  }finally{sqlite.close();}
});
test('P5C-B2 기존34 동일 입력 전체 deep equality 및 고정 digest',async()=>{
  const original=(await oldRows).filter(row=>['PARSED','VERIFIED_PARSED'].includes(row.final_status));
  const final=await rows,baseline={checkpoint:'d4c353f92a745d2eb09807bec4f13e7abf03b09b',rows:original};
  assert.equal(assertP5cb2Regression(final,baseline).protected_documents,34);
  const digests=JSON.parse(readFileSync(new URL('./fixtures/realty-income-p5cb2/regression-digests.json',import.meta.url),'utf8'));
  for(const old of digests.rows)assert.equal(createHash('sha256').update(JSON.stringify(final.find(r=>r.id===old.id))).digest('hex'),old.sha256);
  const broken=structuredClone(final);broken.find(r=>r.id==='2016-q1').records[0].sources[0].section='changed';
  assert.throws(()=>assertP5cb2Regression(broken,baseline),/REGRESSION BLOCKER/);
});
test('P5C-B2 full40 실제 재집계/format/count/coverage/conflict',async()=>{
  const summary=summarize(await rows);assert.deepEqual(summary.statuses,{VERIFIED_PARSED:9,PARSED:31,NEEDS_REVIEW:0,UNKNOWN_FORMAT:0,WRONG_ISSUER:0,SOURCE_UNAVAILABLE:0,PARSER_ERROR:0});
  assert.equal(summary.formats.reduce((sum,row)=>sum+row.documents,0),40);assert.equal(summary.formats.find(r=>r.format===INTEGRATED_FORMAT).documents,4);
  for(const metric of ['FFO','AFFO']){assert.equal(summary.quarterly.metrics[metric]['total/not_applicable'],40);assert.equal(summary.annual.metrics[metric]['total/not_applicable'],10);}
  assert.equal(summary.quarterly.metrics.NORMALIZED_FFO['total/not_applicable'],19);assert.equal(summary.annual.metrics.NORMALIZED_FFO['total/not_applicable'],5);
  assert.equal(summary.dedup.observations,1344);assert.equal(summary.dedup.unique_values,950);assert.equal(summary.dedup.provenance,1344);
  assert.equal(summary.comparison.exact_match,394);assert.equal(summary.comparison.difference,0);assert.deepEqual(summary.dedup.conflicts,[]);
});
test('P5C-B2 definition/version이 다른 값은 기본 identity에서 강제 병합하지 않음',async()=>{
  const pdf=await parse('2025-q4'),sec=(await officialResults())[0];
  const records=[pdf.records.find(r=>r.period_scope==='annual'&&r.fiscal_year===2025),sec.records.find(r=>r.period_scope==='annual'&&r.fiscal_year===2025)];
  assert.equal(deduplicate([{final_status:'PARSED',records}]).unique_values,2);
});
test('P5C-B2 production 승인 목록/adapter는 자동 확장하지 않음',async()=>{
  for(const inspection of modernInspections())assert.notEqual((await parseRealtyIncomeDocument(await modernFixture(inspection.id))).status,'parsed');
});
test('P5C-B2 fixture는 최소 발췌/expected/metadata만, parser expected/연도 분기 없음',()=>{
  const names=readdirSync(new URL('./fixtures/realty-income-p5cb2/',import.meta.url));assert.ok(names.every(name=>name.endsWith('.json')));
  assert.ok(readFileSync(new URL('./fixtures/realty-income-p5cb2/documents.json',import.meta.url)).length<80000);
  for(const file of ['realty-income-modern-pdf.js','realty-income-modern-units.js','realty-income-modern-definitions.js']){
    const code=readFileSync(new URL('../worker/src/reit/'+file,import.meta.url),'utf8').replace(/\/\/[^\n]*/g,'');
    assert.ok(!/\bexpected\b|fiscal_year\s*[=!<>]|ticker\s*[=!<>]|switch\s*\(.*year/.test(code));
  }
});
