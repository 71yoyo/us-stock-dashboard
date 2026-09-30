"""기존 cache의 검토 대상/비교 PDF만 렌더링한다. OCR·네트워크·원문 쓰기는 없다."""
import argparse
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('cache')
parser.add_argument('pdftoppm')
args = parser.parse_args()
cache = Path(args.cache).resolve(strict=True)
repo = Path(__file__).resolve().parent.parent
if cache == repo or repo in cache.parents:
    raise ValueError('QA 출력은 repo 밖이어야 합니다.')
# 검토 목록은 시각 QA 범위일 뿐 parser의 연도별 승인 조건이 아니다.
pages = {'2017-q4':[5,6], '2021-q2':[7,8,32,33], '2021-q3':[7,8,31,32],
         '2021-q4':[7,8,32,33], '2023-q3':[5,6,30,31], '2023-q4':[5,6,30,31], '2024-q1':[5,6,30,31]}
for document, numbers in pages.items():
    for number in numbers:
        prefix = cache / f'b1-qa-{document}-p{number}'
        subprocess.run([args.pdftoppm,'-f',str(number),'-l',str(number),'-scale-to','2000',
                        '-png','-singlefile',str(cache/(document+'.pdf')),str(prefix)],check=True,capture_output=True)
    print(document, numbers, flush=True)
