import { evidence, excerptHash, textHash, failedDocument } from './realty-income-document-formats.js';
import { STRUCTURAL_LEGACY_FORMAT, shareLayout } from './realty-income-structural-strategy.js';
import { extractRealtyIncomePdfStructure } from './realty-income-pdf-parser.js';
import { normalizeHistoricalMetrics } from './realty-income-normalizer.js';
import { modernTableUnit } from './realty-income-modern-units.js';
import { modernDefinitions } from './realty-income-modern-definitions.js';

export const INTEGRATED_FORMAT='REALTY_INCOME_INTEGRATED_PDF_V1';
const compact=text=>text.replace(/\s+/g,' ').trim();
const heading=page=>page.text.split('\n').slice(0,2).join(' ').replace(/^\(1\)\s*/,'').trim();
const kind=page=>/^FFO and Normalized FFO(?:\s|\(|$)/.test(heading(page))?'ffo':/^AFFO(?:\s|\(|$)/.test(heading(page))&&!/Continued/.test(heading(page))?'affo':null;

export function modernTablePair(excerpt,source) {
  const footer=new RegExp(`Q${source.fiscal_period.slice(1)} ${source.fiscal_year} Supplemental Operating & Financial Data (\\d+)`);
  const candidates=excerpt.pages.filter(page=>kind(page)&&/Supplemental Operating & Financial Data/.test(page.text));
  const ffo=candidates.filter(page=>kind(page)==='ffo'),affo=candidates.filter(page=>kind(page)==='affo');
  evidence(ffo.length===1&&affo.length===1,'TABLE_AMBIGUITY','대표 supplemental 조정표가 중복/누락됐습니다.');
  const pair={ffo:ffo[0],affo:affo[0]};
  for(const page of Object.values(pair)) {
    const match=compact(page.text).match(footer);
    evidence(match,'PERIOD_AMBIGUITY','표 footer와 fiscal period가 다릅니다.');
    evidence(Number.isInteger(page.page_number)&&page.page_number>0&&page.page_number<=source.page_count,
      'TABLE_AMBIGUITY','물리 page가 문서 범위를 벗어났습니다.');
  }
  evidence(pair.affo.page_number===pair.ffo.page_number+1,'TABLE_AMBIGUITY','서로 인접한 대표 FFO/AFFO 표가 아닙니다.');
  const printed=page=>Number(compact(page.text).match(footer)[1]);
  evidence(printed(pair.affo)===printed(pair.ffo)+1,'TABLE_AMBIGUITY','printed page 순서가 다릅니다.');
  const definitions=excerpt.definition_excerpts;
  evidence(Array.isArray(definitions)&&definitions.length===3&&definitions.every(page=>page.page_number>pair.affo.page_number
    &&page.page_number<=source.page_count&&Number.isInteger(page.printed_page)),
    'DEFINITION_REVIEW','대표 표 뒤 glossary의 세 metric 정의가 필요합니다.');
  return {pair,printed,footer};
}

function numericView(page,name) {
  const lines=page.text.split('\n').map(line=>compact(line)).filter(Boolean);
  const unit=lines.find(line=>/^\(.*thousands/.test(line));
  const first=lines.findIndex(line=>/Three months ended/.test(line));
  evidence(first>=0,'PERIOD_AMBIGUITY','실제 기간 머리글이 없습니다.');
  // 접힌 각주/콜론만 표준화한다. 공시 숫자·열 순서를 수정하거나 산술값을 만들지 않는다.
  const body=lines.slice(first).map(line=>line
    .replace(/^(Merger, transaction, and other costs(?:, net)?)\((\d+)\)/,'$1 ($2)')
    .replace(/^(FFO|Normalized FFO|AFFO) per common share, basic and diluted:/,'$1 per common share, basic and diluted')
    .replace(/^Basic and Diluted (?=[\d(])/i,'Basic and Diluted $ '));
  return {...page,text:[name,unit,...body].join('\n')};
}

export async function modernPdfFingerprint(excerpt,source) {
  const {pair,printed}=modernTablePair(excerpt,source);
  const units=Object.values(pair).map(modernTableUnit);
  evidence(JSON.stringify(units[0])===JSON.stringify(units[1]),'UNIT_UNKNOWN','두 조정표의 단위가 다릅니다.');
  const integrated=/Earnings\s+Release\s*&\s*Supplemental\s+Information/i.test(excerpt.document_title);
  const supplemental=/SUPPLEMENTAL OPERATING[\s\S]*FINANCIAL DATA/.test(excerpt.document_title);
  evidence(integrated||supplemental,'FORMAT_UNSUPPORTED','문서 section identity가 없습니다.');
  evidence(integrated===units[0].measurement.startsWith('USD and shares'),'FORMAT_UNSUPPORTED','문서 형식과 단위 grammar가 맞지 않습니다.');
  evidence(integrated ? printed(pair.ffo)<pair.ffo.page_number&&printed(pair.affo)<pair.affo.page_number
    : printed(pair.ffo)===pair.ffo.page_number&&printed(pair.affo)===pair.affo.page_number,
    'TABLE_AMBIGUITY','integrated/별도 supplemental 페이지 identity가 다릅니다.');
  if(integrated){
    const notes=excerpt.footnotes||[],note=notes[0];
    evidence(notes.length===1&&note.page_number===pair.affo.page_number+1&&note.printed_page===printed(pair.affo)+1
      &&/^\s*(?:\(1\)\s*)?AFFO(?:\(1\))? \(Continued\)/.test(note.text)
      &&note.text.includes(units[0].raw_label)&&/reconciling items for Normalized FFO/.test(note.text)
      &&compact(note.text).match(new RegExp(`Q${source.fiscal_period.slice(1)} ${source.fiscal_year} Supplemental Operating & Financial Data ${note.printed_page}`)),
      'TABLE_AMBIGUITY','AFFO 다음 페이지의 실제 각주/단위/참조 방향을 확정할 수 없습니다.');
  }
  const ffo=numericView(pair.ffo,'FFO and Normalized FFO (1)'),affo=numericView(pair.affo,'AFFO (1)');
  for(const page of [ffo,affo]) {
    evidence(/^Net income available to common stockholders /m.test(page.text)&&/^Weighted average number of common shares used for /m.test(page.text),
      'TABLE_AMBIGUITY','조정표 시작점 또는 가중주식수 행이 없습니다.');
    evidence(/\nBasic \d[\d,]* /m.test(page.text)&&/\nDiluted \d[\d,]* /m.test(page.text),
      'BASIS_AMBIGUITY','천 주 단위의 별도 weighted shares 행이 없습니다.');
  }
  evidence(/^Diluted FFO /m.test(ffo.text)&&/^Diluted Normalized FFO /m.test(ffo.text)&&/^Diluted AFFO /m.test(affo.text),
    'BASIS_AMBIGUITY','각 metric의 diluted total이 없습니다.');
  const share_layouts={FFO:shareLayout(ffo,'FFO'),NORMALIZED_FFO:shareLayout(ffo,'Normalized FFO'),AFFO:shareLayout(affo,'AFFO')};
  const period_columns=/Years? ended/.test(ffo.text)?'quarter_and_fy':/Nine months ended/.test(ffo.text)?'quarter_and_9m':/Six months ended/.test(ffo.text)?'quarter_and_6m':'single_quarter';
  const features={document_family:integrated?'integrated_earnings_supplemental':'supplemental',
    section:'Supplemental Operating & Financial Data',headings:['FFO and Normalized FFO','AFFO'],
    period_columns,share_layouts,diluted_total:'present',measurement:units[0].measurement,qualifier:units[0].qualifier,
    reconciliation_identity:{FFO:'net_income_to_ffo',NORMALIZED_FFO:'ffo_cost_exclusion',AFFO:'nffo_to_affo'},
    selected_pages:Object.values(pair).map(page=>({physical_page:page.page_number,printed_page:printed(page)})),
    excluded_candidates:excerpt.excluded_candidates||[],definitions_after_tables:true};
  return {format:integrated?INTEGRATED_FORMAT:STRUCTURAL_LEGACY_FORMAT,ffo,affo,normalized:true,diluted:true,
    structural_strategy:features,raw_pair:pair,units,printed,fingerprint:await textHash(JSON.stringify(features))};
}

// 독립 read-only entry point다. 기존 legacy와 production 승인 목록은 변경하지 않는다.
export async function parseModernRealtyIncomePdf({source,excerpt,pdf_hash}) {
  try {
    const url=new URL(source.source_url);
    evidence(source.cik==='0000726728'&&source.issuer==='Realty Income Corporation'&&source.source_type==='ISSUER_IR_PDF'
      &&url.protocol==='https:'&&url.hostname==='www.realtyincome.com'
      &&!url.search&&!url.username&&!url.password
      &&/^Realty Income\b/.test(excerpt.identity_text)&&(/NYSE: O/.test(excerpt.identity_text)
        ||/New York Stock Exchange/.test(excerpt.identity_text)&&/the symbol ["“]O["”]/.test(excerpt.identity_text)),
      'wrong_issuer','발행회사와 공식 IR 출처가 일치하지 않습니다.');
    evidence(/^[a-f0-9]{64}$/.test(pdf_hash||'')&&source.source_hash===pdf_hash&&source.excerpt_hash===await excerptHash(excerpt),
      'SOURCE_HASH_MISMATCH','원문 또는 최소 발췌 hash가 일치하지 않습니다.');
    const detected=await modernPdfFingerprint(excerpt,source);
    evidence(source.ffo_page===detected.ffo.page_number&&source.affo_page===detected.affo.page_number,
      'TABLE_AMBIGUITY','출처에 기록한 표 위치와 실제 물리 페이지가 다릅니다.');
    const definitions=modernDefinitions(excerpt,{ffo:detected.ffo,affo:detected.affo});
    const {observations,availability}=extractRealtyIncomePdfStructure({source},detected,{tableUnit:()=> 'USD thousand'});
    const result=normalizeHistoricalMetrics({observations,definitions,source,format:detected.format,inputHash:source.excerpt_hash,
      availability,structuralFeatures:detected.structural_strategy,definitionEvidence:{paragraphs:excerpt.definition_excerpts,
        ffo_table:detected.raw_pair.ffo.text,affo_table:detected.raw_pair.affo.text,footnotes:excerpt.footnotes||[]}});
    for(const record of result.records)for(const provenance of record.sources){
      const page=record.metric_code==='AFFO'?detected.raw_pair.affo:detected.raw_pair.ffo;
      Object.assign(provenance,{physical_page:page.page_number,printed_page:detected.printed(page),
        raw_table_heading:heading(page),table_fingerprint:detected.fingerprint,
        unit_measurement:detected.units[0].measurement,unit_qualifier:detected.units[0].qualifier,
        weighted_share_count_raw_unit:'shares thousand',weighted_share_count_multiplier:1000});
    }
    return {...result,table_fingerprint:detected.fingerprint,structural_strategy:detected.structural_strategy,unit_audit:detected.units[0]};
  }catch(error){return failedDocument(error);}
}
