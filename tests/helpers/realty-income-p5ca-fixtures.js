import { readFileSync } from 'node:fs';
import { buildAuditExcerpt, buildAuditSource, tablePair, auditDocument } from '../../scripts/realty-income-p5b-core.mjs';
import { p5aIds, p5aDocument, p5aResults, inventoryFixture } from './realty-income-p5a-fixtures.js';
import { historicalIds, historicalDocument, historicalResults } from './realty-income-historical-fixtures.js';

export const p5caFixture = name => JSON.parse(readFileSync(new URL(`../fixtures/realty-income-p5ca/${name}.json`, import.meta.url), 'utf8'));
export async function p5caDocument(id) {
  const { inspection, inventory } = p5caFixture(id), pair = tablePair(inspection), excerpt = buildAuditExcerpt(inspection, pair);
  return { excerpt, source:await buildAuditSource(inventory, inspection, pair, excerpt) };
}
export async function p5caResults() {
  const historical = await historicalResults(), p5a = await p5aResults(), known = new Map();
  for (const [ids, documentAt, results] of [[historicalIds, historicalDocument, historical], [p5aIds, p5aDocument, p5a]]) {
    for (const [index,id] of ids.entries()) {
      const document = documentAt(id), result = results[index];
      known.set(document.source.source_url, { document, result, parse:async () => result });
    }
  }
  const rows = [];
  for (const inventory of inventoryFixture().documents) {
    const old = known.get(inventory.source_url);
    const id = `${inventory.year}-q${inventory.quarter}`;
    // 기존 9개의 immutable 발췌를 재사용한다. 신규/제외 31개는 최소 offline 발췌로 실제 audit 경로를 실행한다.
    const inspection = old ? { download:{ source_url:inventory.source_url, source_hash:old.document.source.source_hash,
      http_status:200, error:null, retrieved_at:old.document.source.retrieved_at }, page_count:old.document.source.page_count,
      identity_text:old.document.excerpt.identity_text, document_title:old.document.excerpt.document_title,
      candidate_tables:old.document.excerpt.pages, definition_excerpts:old.document.excerpt.definition_excerpts,
      filed_at:old.document.source.filed_at, error:null } : p5caFixture(id).inspection;
    rows.push(await auditDocument(inventory, inspection, old));
  }
  return rows;
}
