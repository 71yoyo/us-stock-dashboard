import assert from 'node:assert/strict';
import { buildAuditSource, basisDisclosure } from './realty-income-p5b-core.mjs';
import { excerptHash } from '../worker/src/reit/realty-income-document-formats.js';
import { modernTablePair, parseModernRealtyIncomePdf } from '../worker/src/reit/realty-income-modern-pdf.js';

// 이 목록은 read-only 검토 범위다. parser는 연도/티커로 format이나 값을 결정하지 않는다.
export const MODERN_IDS=['2024-q3','2024-q4','2025-q1','2025-q2','2025-q3','2025-q4'];
export function modernExcerpt(inspection,evidence=inspection){
  return {identity_text:inspection.identity_text,document_title:inspection.document_title,pages:inspection.candidate_tables,
    definition_excerpts:evidence.definition_excerpts,footnotes:evidence.footnotes||[],excluded_candidates:evidence.excluded_candidates||[]};
}
export async function modernDocument(inventory,inspection,evidence=inspection,pdfHash=inspection.download.source_hash){
  const excerpt=modernExcerpt(inspection,evidence);
  const source={...(await buildAuditSource(inventory,inspection,{ffo:{page_number:null},affo:{page_number:null}},excerpt))};
  try{const {pair}=modernTablePair(excerpt,source);source.ffo_page=pair.ffo.page_number;source.affo_page=pair.affo.page_number;}catch{/* 실패 원인은 parser가 기록한다. */}
  source.excerpt_hash=await excerptHash(excerpt);
  return {source,excerpt,pdf_hash:pdfHash};
}
export async function auditModernDocument(inventory,inspection,original,evidence=inspection,pdfHash=inspection.download.source_hash){
  if(!MODERN_IDS.includes(original.id)||['PARSED','VERIFIED_PARSED'].includes(original.final_status)
    ||original.source_status!=='AVAILABLE'||original.final_status==='WRONG_ISSUER')return original;
  const document=await modernDocument(inventory,inspection,evidence,pdfHash);
  const result=await parseModernRealtyIncomePdf(document);
  let pair;
  try{pair=modernTablePair(document.excerpt,document.source).pair;}catch{/* 숫자가 없는 review로 남긴다. */}
  return {...original,period_verified:result.status==='parsed',detected_format:result.format||null,
    adapter:'parseModernRealtyIncomePdf (read-only; production approval unchanged)',
    parser_status:result.status,final_status:result.status==='parsed'?'PARSED':'NEEDS_REVIEW',
    normalized_ffo:pair?'YES':original.normalized_ffo,basis_disclosure:pair?basisDisclosure(pair):original.basis_disclosure,
    unit_audit:result.unit_audit||null,structural_strategy:result.structural_strategy||null,table_fingerprint:result.table_fingerprint||null,
    records:result.records,definitions:result.definitions,availability:result.availability,errors:result.errors};
}
export function assertP5cb2Regression(rows,baseline){
  assert.equal(baseline.checkpoint,'d4c353f92a745d2eb09807bec4f13e7abf03b09b');
  assert.equal(baseline.rows.length,34);
  for(const old of baseline.rows)assert.deepEqual(rows.find(row=>row.id===old.id),old,`[REGRESSION BLOCKER] 기존34 전체: ${old.id}`);
  return {protected_documents:34,full_deep_equality:true};
}
