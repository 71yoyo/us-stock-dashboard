import assert from 'node:assert/strict';

// 정의 버전은 비교 키에서 잠시 제외하되, 원본 결과/DB identity를 수정하지 않는다.
const identity=record=>[record.ticker,record.metric_code,record.definition_owner,record.period_scope,
  record.period_start,record.period_end,record.value_basis,record.share_basis,record.attribution_basis].join('|');
export function compareAnnualSources(pdf,sec){
  assert.equal(pdf.status,'parsed');assert.equal(sec.status,'parsed');
  const pdfAnnual=pdf.records.filter(row=>row.period_scope==='annual'&&row.fiscal_year===row.sources[0].fiscal_year);
  const secAnnual=sec.records.filter(row=>row.period_scope==='annual'&&row.fiscal_year===pdfAnnual[0]?.fiscal_year);
  assert.equal(pdfAnnual.length,12);assert.equal(secAnnual.length,12);
  const pairs=pdfAnnual.map(row=>{
    const matches=secAnnual.filter(other=>identity(other)===identity(row));assert.equal(matches.length,1);
    const other=matches[0];return {identity:identity(row),metric:row.metric_code,basis:row.value_basis,share_basis:row.share_basis,
      pdf_definition:row.definition_version,sec_definition:other.definition_version,
      pdf_value:row.canonical_value,sec_value:other.canonical_value,unit:row.canonical_unit,
      exact:row.canonical_unit===other.canonical_unit&&row.canonical_value===other.canonical_value};
  });
  return {compared:pairs.length,exact:pairs.filter(pair=>pair.exact).length,difference:pairs.filter(pair=>!pair.exact).length,
    conflict:pairs.filter(pair=>!pair.exact).length,pairs,automatic_merge:false};
}

// 테스트 전용 명시적 동등성 검토 view다. canonical parser/store의 version 정책은 바꾸지 않는다.
// SEC의 문서별 version과 IR의 의미별 version은 기본적으로 별도 identity이다.
export function reviewedAnnualProvenanceView(pdf,sec,review){
  const comparison=compareAnnualSources(pdf,sec);
  assert.equal(comparison.difference,0,'CONFLICT: 자동 overwrite 금지');
  assert.equal(review.approved,true);assert.equal(review.evidence_type,'definition_and_reconciliation_review');
  assert.equal(review.sec_source_hash,sec.records[0].sources[0].source_hash);
  assert.equal(review.pdf_source_hash,pdf.records[0].sources[0].source_hash);
  assert.deepEqual(review.metric_versions,Object.fromEntries(pdf.definitions.map(row=>[row.metric_code,row.definition_version])));
  assert.ok(review.note&&review.note.length>20,'숫자 일치만으로 정의 동등성을 승인하지 않습니다.');
  const target=sec.records.filter(row=>row.period_scope==='annual'&&row.fiscal_year===pdf.records[0].sources[0].fiscal_year);
  return {status:'parsed',definitions:structuredClone(sec.definitions),records:target.map(row=>{
    const source=pdf.records.find(other=>identity(other)===identity(row));
    return {...structuredClone(row),sources:[...structuredClone(row.sources),...source.sources.map(provenance=>({...structuredClone(provenance),
      original_definition_version:source.definition_version,original_validation_status:source.validation_status,definition_equivalence_review:review}))]};
  })};
}
