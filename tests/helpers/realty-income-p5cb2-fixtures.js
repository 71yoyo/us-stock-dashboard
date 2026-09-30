import {readFileSync} from 'node:fs';
import {p5cb1Results} from './realty-income-p5cb1-fixtures.js';
import {modernDocument,auditModernDocument} from '../../scripts/realty-income-p5cb2-core.mjs';

export const modernInspections=()=>JSON.parse(readFileSync(new URL('../fixtures/realty-income-p5cb2/documents.json',import.meta.url),'utf8'));
export const modernExpected=()=>JSON.parse(readFileSync(new URL('../fixtures/realty-income-p5cb2/official-expected.json',import.meta.url),'utf8'));
const inventory=JSON.parse(readFileSync(new URL('../fixtures/realty-income-p5a/inventory.json',import.meta.url),'utf8')).documents;
export async function modernFixture(id){const inspection=modernInspections().find(row=>row.id===id);
  const row=inventory.find(row=>row.source_url===inspection.download.source_url);
  return modernDocument(row,inspection);
}
export async function p5cb2Results(){
  const original=await p5cb1Results(),inspections=modernInspections();
  return Promise.all(original.map(row=>{const inspection=inspections.find(i=>i.id===row.id);
    return inspection?auditModernDocument(inventory.find(i=>i.source_url===row.source_url),inspection,row):row;}));
}
