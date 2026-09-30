"""다운로드 완료된 40개 inventory PDF를 repo 밖에서 조사한다. OCR/네트워크/DB 쓰기는 없다."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import pdfplumber
from pypdf import PdfReader


def investigate(cache, pdftotext):
    cache = Path(cache).resolve(strict=True)
    repo = Path(__file__).resolve().parent.parent
    if cache == repo or repo in cache.parents:
        raise ValueError("원문 cache는 repo 밖이어야 합니다.")
    manifest = json.loads((cache / "sources.json").read_text(encoding="utf-8"))
    inventory = json.loads((repo / "tests/fixtures/realty-income-p5a/inventory.json").read_text(encoding="utf-8"))["documents"]
    if len(manifest["sources"]) != 40 or {x["source_url"] for x in manifest["sources"]} != {x["source_url"] for x in inventory}:
        raise ValueError("40개 inventory의 다운로드 결과만 허용합니다.")
    results = []
    for source in manifest["sources"]:
        result = {"download": source, "page_count": None, "identity_text": None, "document_title": None,
                  "period_evidence": [], "candidate_tables": [], "definition_excerpts": [], "filed_at": None,
                  "filed_evidence": None, "error": None}
        if source["error"]:
            results.append(result)
            continue
        try:
            path = cache / (source["id"] + ".pdf")
            if hashlib.sha256(path.read_bytes()).hexdigest() != source["source_hash"]:
                raise ValueError("SOURCE_HASH_MISMATCH")
            # 전체 텍스트는 캐시에만 둔다. Poppler가 없으면 pypdf로 읽고 OCR은 하지 않는다.
            text_path = cache / (source["id"] + ".txt")
            if text_path.is_file():
                pass  # 원문 hash를 먼저 검증한 cache만 재사용한다.
            elif Path(pdftotext).is_file():
                subprocess.run([pdftotext, "-layout", str(path), str(text_path)], check=True, capture_output=True)
            else:
                reader = PdfReader(path)
                text_path.write_text("\f".join(page.extract_text(extraction_mode="layout") for page in reader.pages), encoding="utf-8")
            pages = text_path.read_text(encoding="utf-8").split("\f")
            with pdfplumber.open(path) as pdf:
                result["page_count"] = len(pdf.pages)
                result["document_title"] = pdf.pages[0].extract_text(x_tolerance=2, y_tolerance=3)
                identities = []
                for index, text in enumerate(pages):
                    scan = re.sub(r"\s+", " ", text)
                    filing = re.search(r"(?:filed\s*on|filed with the SEC on) ((?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2},\s*20\d\d)", scan)
                    if filing and result["filed_at"] is None:
                        from datetime import datetime
                        result["filed_at"] = datetime.strptime(re.sub(r",\s*", ", ", filing.group(1)), "%B %d, %Y").date().isoformat()
                        result["filed_evidence"] = {"page_number": index + 1, "text": filing.group()}
                    for line in text.splitlines():
                        if re.search(r"Q[1-4]\s+20\d\d\s+Supplemental Operating", line, re.I):
                            result["period_evidence"].append({"page_number": index + 1, "text": line.strip()})
                    if re.search(r"New York Stock Exchange|NYSE", scan, re.I):
                        page = pdf.pages[index]
                        identity = page.crop((0, 0, page.width * 0.54, page.height)).extract_text(x_tolerance=2, y_tolerance=3) or ""
                        identities.append({"page_number": index + 1, "text": identity})
                    # 설명/목차가 아니라 총액 행과 기간 열을 포함한 reconciliation 페이지만 선택한다.
                    if re.search(r"(?:FFO|AFFO)\s+available to common stockholders", scan, re.I) and re.search(r"(?:Three|Six|Nine|Year).*ended", scan, re.I):
                        page_text = pdf.pages[index].extract_text(x_tolerance=2, y_tolerance=3) or ""
                        result["candidate_tables"].append({"page_number": index + 1, "text": page_text})
                    if re.search(r"We define FFO|Funds From Operations \(FFO\),|FFO adjusted for unique|Normalized Funds from Operations Available", scan):
                        page_text = pdf.pages[index].extract_text(x_tolerance=2, y_tolerance=3) or ""
                        for prefix in ["We define FFO,", "We define AFFO as", "Adjusted Funds From Operations (AFFO),",
                                       "Adjusted Funds From Operations (AFFO)", "Funds From Operations (FFO),", "Normalized Funds from Operations Available"]:
                            start = page_text.find(prefix)
                            if start >= 0:
                                result["definition_excerpts"].append({"page_number": index + 1, "text": "\n".join(page_text[start:].splitlines()[:5])})
                result["identity_candidates"] = identities
                # 기존 기업 소개를 그대로 발췌한다. 표현이 바뀌면 추측하지 않고 audit에서 검토한다.
                for identity in identities:
                    flat = identity["text"].replace("\n", " ")
                    symbol = re.search(r'the symbol ["“”]O["“”]', flat)
                    start = flat.find("Realty Income")
                    if start >= 0 and symbol and "New York Stock Exchange" in flat:
                        company = re.match(r"Realty Income.*?S&P 500", flat[start:])
                        if not company:
                            continue
                        result["identity_text"] = "\n".join([company.group(), "New York Stock Exchange", symbol.group()])
                        result["identity_page"] = identity["page_number"]
                        break
                if result["identity_text"] is None:
                    # 새 회사 소개의 'Realty Income (NYSE: O)'라는 실제 문구만 허용한다. 다른 회사 언급과 구별한다.
                    for identity in identities:
                        flat = re.sub(r"\s+", " ", identity["text"])
                        subject = re.search(r"Realty Income(?: Corporation \(Realty Income, NYSE: O\)| \(NYSE: O\))", flat)
                        if subject:
                            result["identity_text"] = subject.group()
                            result["identity_page"] = identity["page_number"]
                            break
            excerpt_text = json.dumps(result, ensure_ascii=False, indent=2)
            (cache / (source["id"] + ".inspection.json")).write_text(excerpt_text, encoding="utf-8")
        except Exception as error:
            result["error"] = str(error)
        results.append(result)
        print(source["id"], "pages", result["page_count"], "tables", [x["page_number"] for x in result["candidate_tables"]], "identity", bool(result["identity_text"]), "error", result["error"], flush=True)
    (cache / "inspections.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="P5B inventory 40개 PDF의 읽기 전용 구조 조사")
    parser.add_argument("cache")
    parser.add_argument("pdftotext")
    args = parser.parse_args()
    investigate(args.cache, args.pdftotext)
