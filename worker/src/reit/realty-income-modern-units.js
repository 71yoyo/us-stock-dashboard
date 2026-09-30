import { evidence } from './realty-income-document-formats.js';

// 단위와 감사 상태를 별개로 해석한다. 임의 suffix/다른 통화/백만 단위를 묵인하지 않는다.
export function modernTableUnit(page) {
  const lines = page.text.split('\n').map(line=>line.replace(/\s+/g,' ').trim());
  const labels = lines.slice(0,4).filter(line=>/^\(/.test(line)&&/thousands|millions/.test(line));
  evidence(labels.length===1,'UNIT_UNKNOWN','표 머리글의 단위가 중복/누락됐습니다.');
  const match = labels[0].match(/^\((in thousands, except per share amounts|USD and shares in thousands, except per share amounts)\)(?: \((unaudited)\))?$/);
  evidence(match,'UNIT_UNKNOWN','검토하지 않은 단위 또는 상태 qualifier입니다.');
  const year = lines.findIndex(line=>/^\d{4} \d{4}(?: \d{4} \d{4})?$/.test(line));
  evidence(year>=0,'PERIOD_AMBIGUITY','단위 검증에 사용할 기간 열이 없습니다.');
  const width=lines[year].split(' ').length;
  const explicit=match[1].startsWith('USD');
  if(explicit) evidence(lines[year+1]===Array(width).fill('($)').join(' '),
    'UNIT_UNKNOWN','USD 단위와 각 열의 통화 머리글이 일치하지 않습니다.');
  else evidence(/^Net income available to common stockholders\s+\$/m.test(page.text),
    'UNIT_UNKNOWN','in thousands의 실제 달러 표시 근거가 없습니다.');
  return {raw_label:labels[0],measurement:match[1],qualifier:match[2]||null,
    monetary:'USD thousand',monetary_multiplier:1000,per_share:'USD/share',per_share_multiplier:1,
    weighted_shares:'shares thousand',weighted_shares_multiplier:1000};
}
