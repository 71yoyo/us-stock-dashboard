import { readFileSync } from 'node:fs';
import { parseRealtyIncomeDocument } from '../../worker/src/reit/realty-income-document-adapter.js';
import { validateAgainstOfficialExpected } from '../../worker/src/specialized-metrics.js';
import { fixtureHash } from './realty-income-fixtures.js';

export const historicalIds = ['fy2016', 'q2-2019', 'q2-2021', 'q2-2024'];
export function historicalDocument(id) {
  if (!historicalIds.includes(id)) throw new Error('대표 fixture 네 개만 지원합니다.');
  return JSON.parse(readFileSync(new URL(`../fixtures/realty-income-historical/${id}.json`, import.meta.url), 'utf8'));
}
export function historicalExpected() {
  const text = readFileSync(new URL('../fixtures/realty-income-historical/official-expected.json', import.meta.url), 'utf8');
  return { fixture: JSON.parse(text), hash: fixtureHash(text) };
}
export async function historicalResults() {
  const { fixture, hash } = historicalExpected();
  return Promise.all(historicalIds.map(async id => {
    const result = await parseRealtyIncomeDocument(historicalDocument(id));
    if (result.status !== 'parsed') throw new Error(JSON.stringify(result.errors));
    const subset = { records: fixture.records.filter(row => row.fiscal_year === historicalDocument(id).source.fiscal_year) };
    return { ...result, records: validateAgainstOfficialExpected(result.records, subset, hash) };
  }));
}
