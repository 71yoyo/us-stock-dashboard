import { buildCompactSecRawMessage } from './sec-raw-compact-producer.mjs';
import { normalizeCik, safeError } from './sec-raw-automation-policy.mjs';
import { orderedCompactSource } from './sec-raw-producer-identity.mjs';
export { orderedCompactSource } from './sec-raw-producer-identity.mjs';

export function discoverAccessions({submissions,companyFacts,approved,allowedForms,checkpoint,historical}) {
  if (normalizeCik(submissions?.cik)!==normalizeCik(approved.cik) || normalizeCik(companyFacts?.cik)!==normalizeCik(approved.cik) ||
      !Array.isArray(submissions?.tickers) || !submissions.tickers.includes(approved.ticker)) throw safeError('SOURCE_INVALID');
  const recent=submissions.filings?.recent;
  if (!recent || !Array.isArray(recent.accessionNumber) || !Array.isArray(recent.filingDate) || !Array.isArray(recent.form) ||
      recent.accessionNumber.length!==recent.filingDate.length || recent.accessionNumber.length!==recent.form.length) throw safeError('SOURCE_INVALID');
  const all=recent.accessionNumber.map((accession,i)=>({accession,filed:recent.filingDate[i],form:recent.form[i]}));
  if (all.some(row=>!/^\d{10}-\d{2}-\d{6}$/.test(row.accession) || !/^\d{4}-\d{2}-\d{2}$/.test(row.filed)) ||
      new Set(all.map(row=>row.accession)).size!==all.length) throw safeError('SOURCE_INVALID');
  const boundary=checkpoint?.accession??historical?.accession;
  let anchor=all.find(row=>row.accession===boundary);
  if (!anchor) {
    const filed=[];
    for (const tags of Object.values(companyFacts.facts??{})) for (const tag of Object.values(tags))
      for (const rows of Object.values(tag.units??{})) if (Array.isArray(rows))
        for (const row of rows) if (row.accn===boundary && /^\d{4}-\d{2}-\d{2}$/.test(row.filed)) filed.push(row.filed);
    if (filed.length) anchor={accession:boundary,filed:filed.sort().at(-1)};
  }
  // recent 범위 밖에서 누락된 accession을 건너뛰었다고 가정하지 않는다. archive loader는 후속 wiring 범위다.
  if (!anchor || (submissions.filings.files?.length && all.length && anchor.filed<all.map(row=>row.filed).sort()[0])) throw safeError('DISCOVERY_WINDOW_INCOMPLETE');
  const compare=(a,b)=>a.filed.localeCompare(b.filed)||a.accession.localeCompare(b.accession);
  return all.filter(row=>allowedForms.includes(row.form) && (compare(row,anchor)>0 || (checkpoint && row.accession===boundary)))
    .sort(compare);
}
export async function buildDiscoveredMessage({approved,candidate,companyFacts,financialPeriods,enqueuedAt}) {
  const compact=orderedCompactSource(companyFacts,candidate.accession);
  if (!Object.values(compact.facts).some(tags=>Object.keys(tags).length)) return null;
  try { return await buildCompactSecRawMessage({ticker:approved.ticker,accession:candidate.accession,companyFacts:compact,financialPeriods,enqueuedAt}); }
  catch { throw safeError('MESSAGE_INVALID'); }
}
