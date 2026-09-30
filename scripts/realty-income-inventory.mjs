// 공식 자료실의 분기 heading과 issuer 하위 heading을 함께 읽는다. URL의 연도만으로 발행회사를 추측하지 않는다.
export const ARCHIVE_URL = 'https://www.realtyincome.com/investors/quarterly-and-annual-results';
const plain = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
export function parseArchive(html) {
  const headings = [...html.matchAll(/\bid="accordion-item-q([1-4])-(\d{4})"/g)];
  const seen = new Set(), entries = [];
  for (let index = 0; index < headings.length; index++) {
    const [, q, y] = headings[index], key = `${y}-Q${q}`;
    if (seen.has(key)) continue; // 자료실의 desktop/mobile 반복은 문서 중복이 아니다.
    seen.add(key);
    if (Number(y) < 2016 || Number(y) > 2026) continue;
    const block = html.slice(headings[index].index, headings[index + 1]?.index ?? html.length);
    let issuer = 'Realty Income';
    const tokens = /<div[^>]*class="[^"]*label--heading[^"]*"[^>]*>([^<]+)<\/div>|<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const groups = new Map();
    for (const match of block.matchAll(tokens)) {
      if (match[1]) { issuer = plain(match[1]); continue; }
      const label = plain(match[3]);
      if (!['Supplemental', '10-Q/10-K', 'Earnings Release'].includes(label)) continue;
      const group = groups.get(issuer) || {};
      group[label] = new URL(match[2].replaceAll('&amp;', '&'), ARCHIVE_URL).href;
      groups.set(issuer, group);
    }
    for (const [name, links] of groups) entries.push({ year: Number(y), quarter: Number(q),
      archive_issuer_label: name, supplemental_url: links.Supplemental || null,
      earnings_url: links['Earnings Release'] || null, filing_url: links['10-Q/10-K'] || null });
  }
  return entries.sort((a, b) => a.year - b.year || a.quarter - b.quarter || a.archive_issuer_label.localeCompare(b.archive_issuer_label));
}

// SUPPORTED는 같은 URL에 대해 성공한 adapter 검증 근거가 있을 때만 허용한다.
export function inventoryStatus(row, verification = null) {
  if (row.archive_issuer_label !== 'Realty Income') return 'WRONG_ISSUER';
  if (!row.supplemental_url) return 'MISSING';
  if (verification?.source_url === row.supplemental_url && verification.adapter_verified === true) return 'SUPPORTED';
  if (verification?.needs_review) return 'NEEDS_REVIEW';
  if (verification?.fingerprint_observed && verification.adapter_candidate) return 'LIKELY_SUPPORTED';
  return 'UNKNOWN_FORMAT';
}

export function makeInventory(entries, verifications = []) {
  return entries.map(entry => {
    const verified = verifications.find(row => row.source_url === entry.supplemental_url);
    const own = entry.archive_issuer_label === 'Realty Income';
    return { ...entry, period_type: entry.quarter === 4 ? 'Q4/FY' : 'quarterly',
      source_url: entry.supplemental_url, source_type: 'ISSUER_IR_PDF', source_channel: 'IR',
      accession: verified?.accession ?? null, exhibit: verified?.exhibit ?? null,
      document_name: entry.supplemental_url?.split('/').at(-1) ?? null,
      document_format: entry.supplemental_url?.endsWith('.pdf') ? 'PDF' : null,
      issuer: own ? 'Realty Income Corporation' : entry.archive_issuer_label,
      CIK: own ? '0000726728' : null,
      identity_evidence: '공식 IR archive issuer heading (본문 검증은 검증된 표본만)',
      published_at: verified?.published_at ?? null, filed_at: verified?.filed_at ?? null,
      available: verified?.adapter_verified ? true : entry.supplemental_url ? null : false,
      availability_evidence: verified?.adapter_verified ? '직접 확보한 원문/adapter 검증' : 'IR 자료실 링크 존재; HTTP/본문 확보 가능 여부는 미확인',
      format_detected: verified?.format_detected ?? null, adapter_candidate: verified?.adapter_candidate ?? null,
      status: inventoryStatus(entry, verified), normalized_ffo: verified?.normalized_ffo ?? 'UNKNOWN',
      notes: own ? (entry.quarter === 4 ? 'Q4 supplemental은 3개월/Q4 및 연간/FY 조정표 후보. 10-K/annual report는 별도 문서이며 중복 숫자를 재저장하지 않음.' : '기간은 IR 분기 heading에서 확인; 본문 미확인 문서는 지원 확정 금지.') : 'O inventory 밖의 회사 자료. 수집/파싱 대상에서 제외.' };
  });
}
