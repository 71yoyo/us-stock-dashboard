"""기존 PDF만 렌더링한다. 원문·OCR·네트워크는 사용하거나 변경하지 않는다."""
import argparse
from pathlib import Path
import subprocess
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('cache')
parser.add_argument('pdftoppm')
args = parser.parse_args()
cache = Path(args.cache).resolve(strict=True)
repo = Path(__file__).resolve().parent.parent
if cache == repo or repo in cache.parents:
    raise ValueError('QA 출력은 repo 밖이어야 합니다.')
# 목록은 수동 검토 범위이며 parser 승인 조건이 아니다.
pages = {'2024-q2':[5,6,30,31], '2024-q3':[5,6,30,31], '2024-q4':[5,6,30,31],
         '2025-q1':[32,33,34,56,57,58], '2025-q2':[33,34,35,57,58,59],
         '2025-q3':[33,34,35,58,59,60], '2025-q4':[34,35,36,59,60,61]}
for document, numbers in pages.items():
    images = []
    for number in numbers:
        prefix = cache / f'b2-qa-{document}-p{number}'
        subprocess.run([args.pdftoppm,'-f',str(number),'-l',str(number),'-scale-to','2000',
                        '-png','-singlefile',str(cache/(document+'.pdf')),str(prefix)],check=True,capture_output=True)
        images.append(Image.open(str(prefix)+'.png').convert('RGB'))
    for index in range(0,len(images),2):
        pair = images[index:index+2]
        output = Image.new('RGB',(sum(image.width for image in pair),max(image.height for image in pair)),'white')
        left = 0
        for image in pair:
            output.paste(image,(left,0)); left += image.width
        output.save(cache/f'b2-qa-{document}-pair{index//2}.png')
    print(document,numbers,flush=True)
