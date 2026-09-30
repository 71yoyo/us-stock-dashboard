import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseRealtyIncomeHtml } from '../../worker/src/reit/realty-income-parser.js';
import { validateAgainstOfficialExpected } from '../../worker/src/specialized-metrics.js';

export const fixtureHash = text => createHash('sha256').update(text).digest('hex');
export function loadOfficialDocument(id) {
  // apply_patch의 마지막 개행만 제거한다. 숫자/셀/기간 머리글은 수정하지 않는다.
  const html = readFileSync(new URL(`../fixtures/realty-income/${id}.html`, import.meta.url), 'utf8').trimEnd();
  const source = JSON.parse(readFileSync(new URL(`../fixtures/realty-income/${id}.source.json`, import.meta.url), 'utf8'));
  return { html, source };
}
export function loadExpected() {
  const text = readFileSync(new URL('../fixtures/realty-income/official-expected.json', import.meta.url), 'utf8');
  return { fixture: JSON.parse(text), hash: fixtureHash(text) };
}
export async function officialResults() {
  const { fixture, hash } = loadExpected();
  return Promise.all(['fy2025', 'q2-2026'].map(async id => {
    const result = await parseRealtyIncomeHtml(loadOfficialDocument(id));
    if (result.status !== 'parsed') throw new Error(JSON.stringify(result.errors));
    const subset = { records: fixture.records.filter(row => row.definition_version === result.definitions[0].definition_version) };
    return { ...result, records: validateAgainstOfficialExpected(result.records, subset, hash) };
  }));
}
