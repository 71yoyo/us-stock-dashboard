import assert from 'node:assert/strict';
import { pdfFingerprint } from '../worker/src/reit/realty-income-document-formats.js';
import { parseReviewedRealtyIncomePdf } from '../worker/src/reit/realty-income-definition-review.js';
import { auditDocument, buildAuditExcerpt, buildAuditSource, tablePair } from './realty-income-p5b-core.mjs';

// 이 목록은 이번 read-only 검토 범위다. parser는 연도/티커별 분기를 사용하지 않는다.
export const REVIEW_IDS = ['2017-q4','2021-q3','2023-q4'];
export const MODERN_BLOCKED_IDS = ['2024-q3','2024-q4','2025-q1','2025-q2','2025-q3','2025-q4'];

export async function auditReviewedDocument(inventory, inspection, legacy = null) {
  const original = legacy || await auditDocument(inventory,inspection);
  // 기존 성공/issuer 오류/미지원 단위는 수정하지 않는다. 검토한 실패만 별도 entry point로 보낸다.
  if (!REVIEW_IDS.includes(original.id) || original.final_status !== 'NEEDS_REVIEW'
    || !original.period_verified || !original.unit_audit?.supported) return original;
  const pair = tablePair(inspection), excerpt = buildAuditExcerpt(inspection,pair);
  const source = await buildAuditSource(inventory,inspection,pair,excerpt);
  const result = await parseReviewedRealtyIncomePdf({source,excerpt},pdfFingerprint(excerpt));
  const {structure_status, definition_status, ...out} = original;
  return {...out,adapter:'parseReviewedRealtyIncomePdf (read-only; production approval unchanged)',
    parser_status:result.status,final_status:result.status === 'parsed' ? 'PARSED' : 'NEEDS_REVIEW',
    format_status:result.format_status || 'supported',definition_status:result.definition_status || 'approved',
    value_status:result.value_status || 'parsed',records:result.records,definitions:result.definitions,
    availability:result.availability || [],errors:result.errors};
}

export function assertP5cb1Regression(rows, baseline, legacyRows) {
  assert.equal(baseline.checkpoint,'99592cc92a2fe08d33f84881f9e76643b06ae88f');
  assert.equal(baseline.rows.length,31);
  for (const old of baseline.rows) assert.deepEqual(rows.find(row=>row.id===old.id),old,
    `[REGRESSION BLOCKER] 기존 31개 전체 결과: ${old.id}`);
  for (const id of MODERN_BLOCKED_IDS) {
    const row = rows.find(row=>row.id===id);
    assert.equal(row.final_status,'UNKNOWN_FORMAT'); assert.equal(row.records.length,0);
    assert.deepEqual(row,legacyRows.find(row=>row.id===id),'[REGRESSION BLOCKER] modern 문서 변경');
  }
  assert.ok(rows.every(row=>REVIEW_IDS.includes(row.id)||JSON.stringify(row)===JSON.stringify(legacyRows.find(r=>r.id===row.id))));
  return {protected_documents:31,full_deep_equality:true,modern_blocked:6};
}
