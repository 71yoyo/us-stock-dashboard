"""기존 cache에서 최소 표·정의 발췌를 표준 출력한다. 파일을 쓰거나 다운로드하지 않는다."""
import json
import hashlib
import re
import sys
from pathlib import Path
import pdfplumber

cache = Path(sys.argv[1]).resolve(strict=True)
repo = Path(__file__).resolve().parent.parent
if cache == repo or repo in cache.parents:
    raise ValueError('원문 cache는 repo 밖이어야 합니다.')
ids = ['2024-q3','2024-q4','2025-q1','2025-q2','2025-q3','2025-q4']
output = []
for identifier in ids:
    inspection = json.loads((cache/(identifier+'.inspection.json')).read_text(encoding='utf-8'))
    if hashlib.sha256((cache/(identifier+'.pdf')).read_bytes()).hexdigest() != inspection['download']['source_hash']:
        raise ValueError('원문 source hash 불일치')
    selected = [p for p in inspection['candidate_tables'] if re.match(r'^(?:\(1\)\s*)?(?:FFO and Normalized FFO|AFFO(?:\s|\())',p['text'])
                and 'Supplemental Operating & Financial Data' in p['text'] and '(Continued)' not in p['text'].split('\n')[0]]
    if len(selected) != 2:
        raise ValueError('대표 조정표 두 개를 확정할 수 없습니다.')
    end = max(p['page_number'] for p in selected)
    definitions = []
    footnotes = []
    with pdfplumber.open(cache/(identifier+'.pdf')) as pdf:
        for number,page in enumerate(pdf.pages,1):
            if number <= end:
                continue
            text = page.extract_text(layout=False,x_tolerance=2,y_tolerance=3) or ''
            compact = re.sub(r'\s+',' ',text)
            footer = re.search(r'Q[1-4] \d{4} Supplemental Operating & Financial Data (\d+)',compact)
            for label in [r'Adjusted Funds [Ff]rom Operations \(AFFO\)',r'Funds [Ff]rom Operations \(FFO\)',
                          r'Normalized Funds [Ff]rom Operations Available to Common Stockholders \(Normalized FFO\)']:
                match = re.search(label+r',.*?\.(?: |$)',compact)
                if match and 'Glossary' in text.split('\n')[0]:
                    definitions.append({'page_number':number,'printed_page':int(footer[1]) if footer else number,'text':match[0].strip()})
            if number == end+1 and re.match(r'^(?:\(1\)\s*)?AFFO.*Continued',compact):
                footnotes.append({'page_number':number,'printed_page':int(footer[1]),'text':text})
    # 제외 후보는 제목/문맥만 보존한다. release·역사 요약·부록 전체 숫자 표는 fixture에 넣지 않는다.
    excluded = [{'page_number':p['page_number'],'heading':p['text'].split('\n')[0],
                 'role':'appendix' if 'Appendix' in p['text'].split('\n')[0] else 'release_or_summary'}
                for p in inspection['candidate_tables'] if p not in selected]
    if len(definitions) != 3:
        raise ValueError('Glossary의 세 metric 정의를 확정할 수 없습니다.')
    output.append({'id':identifier,'download':inspection['download'],'page_count':inspection['page_count'],
                   'identity_text':inspection['identity_text'],'document_title':inspection['document_title'],
                   'filed_at':inspection['filed_at'],'filed_evidence':inspection['filed_evidence'],
                   'candidate_tables':selected,'definition_excerpts':definitions,'footnotes':footnotes,
                   'excluded_candidates':excluded})
print(json.dumps(output,ensure_ascii=False,indent=2))
