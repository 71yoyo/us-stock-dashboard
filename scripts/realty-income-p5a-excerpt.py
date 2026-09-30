"""P5A의 승인된 PDF 한 개를 읽고 최소 표/정의/회사 발췌만 반환한다. OCR/네트워크/DB 쓰기는 없다."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import pdfplumber


def extract(document_id, pdf_path):
    if document_id not in {"2017-q1", "2018-q3", "2020-q3", "2022-q3", "2023-q3"}:
        raise ValueError("승인된 다섯 표본의 단일 문서만 허용합니다. 전체 inventory 반복 파싱 금지.")
    fixture = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "realty-income-p5a" / (document_id + ".json")
    source = json.loads(fixture.read_text(encoding="utf-8"))["source"]
    path = Path(pdf_path).resolve(strict=True)
    if path.suffix.lower() != ".pdf" or path.stat().st_size > 20000000:
        raise ValueError("허용된 크기의 PDF가 아닙니다.")
    if hashlib.sha256(path.read_bytes()).hexdigest() != source["source_hash"]:
        raise ValueError("공식 표본 원문 hash 불일치.")
    with pdfplumber.open(path) as pdf:
        if len(pdf.pages) != source["page_count"]:
            raise ValueError("원문 페이지 수 불일치.")

        def text(number):
            value = pdf.pages[number - 1].extract_text(x_tolerance=2, y_tolerance=3)
            if not value:
                raise ValueError("needs_review: 텍스트 없는 페이지. OCR 자동 실행 금지.")
            return value

        # 양단 소개 표의 우측 연락정보를 제외하며 티커/거래소 근거만 남긴다.
        page = pdf.pages[2]
        lines = page.crop((0, 0, page.width * 0.54, page.height)).extract_text(x_tolerance=2, y_tolerance=3).splitlines()
        company = re.match(r"^Realty Income.*?S&P 500", next(line for line in lines if line.startswith("Realty Income"))).group()
        exchange = next(line for line in lines if "New York Stock Exchange" in line)
        exchange = exchange[:exchange.index("Exchange") + len("Exchange")]
        symbol = re.search(r'the symbol ["“]O["“]', next(line for line in lines if line.startswith("the symbol "))).group()
        definitions = []
        pages = [30, 31] if source["fiscal_year"] >= 2022 else [source["ffo_page"], source["affo_page"]]
        for number in pages:
            value = text(number)
            for prefix in ["We define FFO,", "We define AFFO as", "Adjusted Funds From Operations (AFFO),",
                           "Funds From Operations (FFO),", "Normalized Funds from Operations Available"]:
                start = value.find(prefix)
                if start >= 0:
                    count = 2 if prefix.startswith("Normalized") else 3
                    definitions.append({"page_number": number, "text": "\n".join(value[start:].splitlines()[:count])})
        tables = []
        for number in [source["ffo_page"], source["affo_page"]]:
            lines = text(number).splitlines()
            start = next(index for index, line in enumerate(lines) if line.lower().startswith("three months ended"))
            tables.append({"page_number": number, "text": "\n".join(lines[:2] + lines[start:])})
        excerpt = {"identity_text": "\n".join([company, exchange, symbol]), "document_title": text(1),
                   "pages": tables, "definition_excerpts": definitions}
    digest = hashlib.sha256(json.dumps(excerpt, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    if digest != source["excerpt_hash"]:
        raise ValueError("최소 발췌 재현 hash 불일치. fixture를 자동 덮어쓰지 않습니다.")
    return {"source": source, "excerpt": excerpt}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="P5A 표본 PDF 단일 문서 읽기 전용 최소 발췌")
    parser.add_argument("document_id")
    parser.add_argument("pdf_path")
    args = parser.parse_args()
    try:
        print(json.dumps(extract(args.document_id, args.pdf_path), ensure_ascii=False, indent=2))
    except (ValueError, OSError, StopIteration, AttributeError) as error:
        parser.exit(1, "발췌 실패: " + str(error) + "\n")
