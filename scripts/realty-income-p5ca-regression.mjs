import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// 보호 목록은 audit/test의 범위 계약일 뿐 parser의 연도별 분기 조건이 아니다.
export const DEFERRED_DOCUMENT_IDS = ['2017-q4', '2021-q3', '2024-q3', '2024-q4', '2025-q1', '2025-q2', '2025-q3', '2025-q4'];
export const STRUCTURAL_CANDIDATE_IDS = ['2016-q1', '2017-q3', '2018-q1', '2018-q2', '2019-q1', '2019-q4', '2020-q1',
  '2020-q4', '2021-q1', '2021-q4', '2022-q4', '2023-q1', '2023-q2', '2023-q4', '2024-q1'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function assertP5caRegression(rows, baseline, frozenRows = null) {
  const manifest = baseline.documents;
  assert.equal(baseline.checkpoint, '05c68bd7164334f4e8e78af8b28e05013cf532cd');
  assert.equal(manifest.length, 17, '[REGRESSION BLOCKER] 기존 17개 manifest 필요');
  for (const expected of manifest) {
    const actual = rows.find(row => row.id === expected.id);
    assert.ok(actual, '[REGRESSION BLOCKER] 기존 문서 누락');
    assert.deepEqual({ status:actual.final_status, format:actual.detected_format, source_hash:actual.source_hash,
      record_count:actual.records.length, records_digest:digest(actual.records), definitions_digest:digest(actual.definitions) },
    { status:expected.status, format:expected.format, source_hash:expected.source_hash, record_count:expected.record_count,
      records_digest:expected.records_digest, definitions_digest:expected.definitions_digest }, `[REGRESSION BLOCKER] ${actual.id}`);
    if (frozenRows) {
      // 출처/provenance는 records 안의 모든 필드를 포함한다. 상태/availability/구조도 전체 deep equality로 비교한다.
      assert.deepEqual(actual, frozenRows.find(row => row.id === expected.id), `[REGRESSION BLOCKER] ${actual.id} 전체 결과`);
    }
  }
  for (const id of DEFERRED_DOCUMENT_IDS) {
    const row = rows.find(row => row.id === id);
    assert.ok(row && ['NEEDS_REVIEW', 'UNKNOWN_FORMAT'].includes(row.final_status) && row.records.length === 0,
      `[REGRESSION BLOCKER] 제외 문서 ${id} 자동 지원 금지`);
  }
  return { baseline_documents:17, full_deep_equality:frozenRows !== null, deferred_documents:8 };
}
