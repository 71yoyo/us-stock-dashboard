"""40개 조사 문서의 조정표를 연도별 접촉 시트로 렌더링한다. repo 밖 QA 이미지이며 데이터 저장은 없다."""
import argparse
import json
from pathlib import Path
import subprocess
from PIL import Image, ImageDraw


def render(cache, pdftoppm):
    cache = Path(cache).resolve(strict=True)
    repo = Path(__file__).resolve().parent.parent
    if cache == repo or repo in cache.parents:
        raise ValueError("QA cache는 repo 밖이어야 합니다.")
    rows = json.loads((cache / "dry-run-summary.json").read_text(encoding="utf-8"))["rows"]
    if len(rows) != 40:
        raise ValueError("40개 inventory 결과가 필요합니다.")
    for year in range(2016, 2026):
        panels = []
        for row in [row for row in rows if row["year"] == year]:
            pages = row["structure"]["pages"]
            for number in pages:
                prefix = cache / f"qa-{row['id']}-p{number}"
                output = prefix.with_suffix(".png")
                if not output.exists():
                    subprocess.run([pdftoppm, "-f", str(number), "-l", str(number), "-scale-to", "1600", "-png", "-singlefile", str(cache / (row["id"] + ".pdf")), str(prefix)], check=True, capture_output=True)
                with Image.open(output) as image:
                    panel = Image.new("RGB", (1600, 1100), "white")
                    image.thumbnail((1600, 1060))
                    panel.paste(image, (0, 40))
                    ImageDraw.Draw(panel).text((10, 10), f"{row['id']} physical page {number}", fill="black")
                    panels.append(panel)
        sheet = Image.new("RGB", (3200, 4400), "white")
        for index, panel in enumerate(panels):
            sheet.paste(panel, (index % 2 * 1600, index // 2 * 1100))
        sheet.save(cache / f"qa-{year}.png")
        print(year, "8 tables rendered", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="P5B 조정표 읽기 전용 시각 확인")
    parser.add_argument("cache")
    parser.add_argument("pdftoppm")
    args = parser.parse_args()
    render(args.cache, args.pdftoppm)
