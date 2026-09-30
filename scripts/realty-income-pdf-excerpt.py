"""한 개의 승인된 대표 PDF만 읽고 최소 발췌 JSON을 stdout으로 반환한다. 원문/DB 쓰기·OCR·네트워크는 없다."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import pdfplumber


def extract(document_id, pdf_path):
    allowed = {"fy2016", "q2-2019", "q2-2021", "q2-2024"}
    if document_id not in allowed:
        raise ValueError("대표 문서 네 개만 지원합니다. 전체 문서 반복 수집 도구가 아닙니다.")
    fixture_path = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "realty-income-historical" / (document_id + ".json")
    source = json.loads(fixture_path.read_text(encoding="utf-8"))["source"]
    pdf_path = Path(pdf_path).resolve(strict=True)
    if pdf_path.suffix.lower() != ".pdf" or pdf_path.stat().st_size > 20000000:
        raise ValueError("PDF 형식/크기가 허용 범위가 아닙니다.")
    if hashlib.sha256(pdf_path.read_bytes()).hexdigest() != source["source_hash"]:
        raise ValueError("공식 대표 PDF 원문 hash가 다릅니다.")
    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) != source["page_count"]:
            raise ValueError("공식 PDF 페이지 수가 다릅니다.")

        def page_text(number):
            text = pdf.pages[number - 1].extract_text(x_tolerance=2, y_tolerance=3)
            if not text:
                raise ValueError("needs_review: 텍스트 없는 페이지. OCR 자동 실행 금지.")
            return text

        # 소개 페이지의 회사·거래소·ticker 세 줄만 남긴다. 오른쪽 임원/연락정보는 fixture에서 제외한다.
        identity_lines = page_text(3).splitlines()
        company = next(line for line in identity_lines if line.startswith("Realty Income"))
        company = re.split(r" John P\. Case| Sumit Roy,| Neil M\. Abraham,", company)[0]
        exchange = next(line for line in identity_lines if "stock is traded on the new york stock exchange" in line.lower()).split(" ▪")[0]
        symbol = next(line for line in identity_lines if line.startswith("the symbol ")).split(" Corporate Headquarters")[0]
        glossary_pages = {"fy2016": [], "q2-2019": [], "q2-2021": [32, 33], "q2-2024": [30, 31]}[document_id]
        definitions = []
        for number in glossary_pages:
            text = page_text(number)
            for prefix in ["Adjusted Funds From Operations (AFFO)", "Funds From Operations (FFO),", "Normalized Funds from Operations Available"]:
                start = text.find("\n" + prefix)
                if start >= 0:
                    count = 2 if prefix.startswith("Normalized") else 3
                    definitions.append({"page_number": number, "text": "\n".join(text[start + 1:].splitlines()[:count])})
        excerpt = {"identity_text": "\n".join([company, exchange, symbol]), "document_title": page_text(1),
                   "pages": [{"page_number": number, "text": page_text(number)} for number in [source["ffo_page"], source["affo_page"]]],
                   "definition_excerpts": definitions}
    # JavaScript JSON.stringify와 동일한 compact UTF-8 표현으로 hash를 계산한다.
    source["excerpt_hash"] = hashlib.sha256(json.dumps(excerpt, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    return {"source": source, "excerpt": excerpt}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="승인된 대표 PDF 한 개의 최소 발췌만 읽기 전용 추출")
    parser.add_argument("document_id")
    parser.add_argument("pdf_path")
    args = parser.parse_args()
    try:
        print(json.dumps(extract(args.document_id, args.pdf_path), ensure_ascii=False, indent=2))
    except (ValueError, OSError, StopIteration) as error:
        parser.exit(1, "발췌 실패: " + str(error) + "\n")
