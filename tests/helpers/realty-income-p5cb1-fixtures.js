import { readFileSync } from 'node:fs';
import { p5caFixture, p5caResults } from './realty-income-p5ca-fixtures.js';
import { REVIEW_IDS, auditReviewedDocument } from '../../scripts/realty-income-p5cb1-core.mjs';

export const p5cb1Expected = () => JSON.parse(readFileSync(new URL('../fixtures/realty-income-p5cb1/official-expected.json',import.meta.url),'utf8'));
export async function p5cb1Results() {
  const original = await p5caResults();
  // 31개 성공/미지원 6개의 최소 fixture는 이전 Phase 그대로 사용한다.
  return Promise.all(original.map(row => {
    if (!REVIEW_IDS.includes(row.id)) return row;
    const {inventory,inspection} = p5caFixture(row.id);
    return auditReviewedDocument(inventory,inspection,row);
  }));
}
