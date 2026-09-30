import { evidence } from './realty-income-document-formats.js';
import { historicalDefinition } from './realty-income-normalizer.js';

const sources={gross:'https://www.realtyincome.com/sites/realty-income/files/2024-11/realty-income-q3-2024-supplemental-information.pdf',
  net:'https://www.realtyincome.com/sites/realty-income/files/2025-02/realty-income-q4-2024-supplemental-information.pdf'};
// 연도/레이아웃이 아닌 공시된 제외 원칙 변경만 새 정의로 등록한다. 기존 버전은 수정하지 않는다.
export function modernDefinitions(excerpt,pair) {
  const text=excerpt.definition_excerpts.map(p=>p.text).join(' ').replace(/\s+/g,' ');
  evidence(/impairments of depreciable real estate assets/.test(text)&&/reduced by gain on property sales/.test(text),
    'DEFINITION_REVIEW','FFO 손상 범위를 확인해야 합니다.');
  evidence(/FFO adjusted for unique revenue and expense items/.test(text),'DEFINITION_REVIEW','AFFO 정의가 없습니다.');
  const statements=text.match(/is FFO excluding [^.]+\./g)||[];
  evidence(statements.length===1,'DEFINITION_REVIEW','NFFO 정의가 중복/누락됐습니다.');
  const match=statements[0].match(/^is FFO excluding merger, transaction, and other costs(, net)?\.$/);
  evidence(match,'DEFINITION_REVIEW','승인하지 않은 NFFO 제외 범위입니다.');
  const net=Boolean(match[1]),label=`Merger, transaction, and other costs${net?', net':''}`;
  const lines=pair.ffo.text.split('\n'), adjustment=lines.filter(line=>line.startsWith(label+' '));
  evidence(adjustment.length===1&&!lines.some(line=>/^Merger,/.test(line)&&!line.startsWith(label+' ')),
    'DEFINITION_REVIEW','정의와 실제 NFFO 조정행이 다릅니다.');
  const nffo=lines.findIndex(line=>/^Normalized FFO available to common stockholders /.test(line));
  evidence(nffo>1&&lines[nffo-1].startsWith(label+' ')&&/^FFO available to common stockholders /.test(lines[nffo-2]),
    'DEFINITION_REVIEW','NFFO가 FFO에서 승인된 비용만 조정하는 구조가 아닙니다.');
  const start=pair.affo.text.match(/^Normalized FFO available to common stockholders (.+)$/m);
  evidence(start&&start[1].replace(/\$\s*/g,'')===lines[nffo].replace(/^Normalized FFO available to common stockholders /,'').replace(/\$\s*/g,''),
    'DEFINITION_REVIEW','AFFO 시작점과 해당 NFFO 공시값이 다릅니다.');
  // 공개 정의가 포괄적이므로 실제 조정행도 제한한다. 새로운 조정항목을 임의 승인하지 않는다.
  const affine=pair.affo.text.split('\n'), finish=affine.findIndex(line=>/^AFFO available to common stockholders /.test(line));
  const begin=affine.findIndex(line=>/^Normalized FFO available to common stockholders /.test(line));
  const allowed=/^(?:Excess of redemption value|Amortization of (?:share-based compensation|net debt discounts|acquired interest rate swap|above and below-market leases)|Non-cash change in allowance for credit losses|Leasing costs and commissions|Recurring capital expenditures|Straight-line rent and expenses, net|Proportionate share of adjustments for unconsolidated entities|Deferred tax (?:expense|benefit|\(benefit\) expense)|Other adjustments|Debt-related non-cash items:|Capital expenditures from operating properties:|Other non-cash items:)/;
  evidence(finish>begin&&affine.slice(begin+1,finish).every(line=>allowed.test(line)),'DEFINITION_REVIEW','새 AFFO 조정항목 검토가 필요합니다.');
  for(const label of ['Amortization of share-based compensation','Straight-line rent and expenses, net','Leasing costs and commissions'])
    evidence(affine.some(line=>line.startsWith(label)),'DEFINITION_REVIEW','주요 AFFO 조정 원칙이 누락됐습니다.');
  const suffix=net?'-NET':'',notes=net?'순액 기준 합병·거래·기타 비용 제외. 이전 gross 범위와 자동 동등시하지 않음.':'합병·거래·기타 비용 제외. 이전 합병·통합 비용 범위와 자동 동등시하지 않음.';
  const make=(metric,version)=>({metric_code:metric,definition_owner:'CIK0000726728',definition_version:version,
    display_name:metric,profile:'REIT',metric_family:'real_estate_cash_earnings',default_unit:'USD',
    definition_source:sources[net?'net':'gross'],definition_notes:notes+(metric==='AFFO'?' 해당 NFFO를 시작점으로 고유 수익/비용 조정.':'')});
  return [historicalDefinition('FFO-DEPRECIABLE-V1'),
    make('NORMALIZED_FFO',`NFFO-MERGER-TRANSACTION-OTHER${suffix}-V1`),
    make('AFFO',`AFFO-NFFO-TRANSACTION-OTHER${suffix}-V1`)];
}
