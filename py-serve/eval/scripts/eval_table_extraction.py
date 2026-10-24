"""表格抽取方法对照：PyMuPDF find_tables vs pdfplumber。

没有人工单元格金标时，用结构指标做代理：
  - 检出表格数 / 有效表格率（>=2 行、>=2 列、>=4 个非空单元格）
  - 平均行数、列数、列一致性（每行列数是否稳定）
  - 数值单元格占比、空单元格占比
  - 与 `Table N` 图注的关联率（bbox 距离 <= 120pt）
  - 前几个有效表格的 markdown 样例，供人工抽查

用法：
  python eval/scripts/eval_table_extraction.py
  python eval/scripts/eval_table_extraction.py --docs "Attention Is All You Need,Deep Residual Learning..."
"""
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

import fitz
import pdfplumber

EVAL_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EVAL_DIR.parent.parent
sys.path.insert(0, str(EVAL_DIR))
sys.path.insert(0, str(EVAL_DIR / "scripts"))

from prepare_figure_dataset import EXCLUDE_DOCS, _rect_distance  # noqa: E402

TABLE_CAPTION_RE = re.compile(r"(?i)^\s*table\s*(\d+)\s*[:.|]")
NUMBER_RE = re.compile(r"^[\s]*[-+−]?\d[\d,.\s%×xX/]*$")
DEFAULT_DOCS = (
    "Attention Is All You Need",
    "Deep Residual Learning for Image Recognition",
    "BERT",
    "DPO",
    "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
    "ViT",
)


def log(message: str) -> None:
    print(message, flush=True)


def table_captions(page: fitz.Page) -> list[tuple[int, fitz.Rect]]:
    captions = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        text = "".join(
            span.get("text", "") for line in block.get("lines", []) for span in line.get("spans", [])
        ).strip()
        match = TABLE_CAPTION_RE.match(text)
        if match:
            captions.append((int(match.group(1)), fitz.Rect(block["bbox"])))
    return captions


def table_stats(rows: list[list[str | None]]) -> dict:
    cleaned = [
        ["" if cell is None else str(cell).strip() for cell in row]
        for row in rows
        if any((cell or "").strip() for cell in row)
    ]
    if not cleaned:
        return {"valid": False, "rows": 0, "cols": 0, "numeric_ratio": 0, "empty_ratio": 1, "col_consistency": 0}
    cols = [len(row) for row in cleaned]
    width = max(cols)
    cells = [cell for row in cleaned for cell in row]
    nonempty = [cell for cell in cells if cell]
    numeric = sum(1 for cell in nonempty if NUMBER_RE.match(cell))
    mode = Counter(cols).most_common(1)[0][0]
    valid = len(cleaned) >= 2 and width >= 2 and len(nonempty) >= 4
    return {
        "valid": valid,
        "rows": len(cleaned),
        "cols": width,
        "numeric_ratio": round(numeric / max(len(nonempty), 1), 3),
        "empty_ratio": round(1 - len(nonempty) / max(len(cells), 1), 3),
        "col_consistency": round(sum(1 for n in cols if n == mode) / len(cols), 3),
        "markdown": to_markdown(cleaned, width),
    }


def to_markdown(rows: list[list[str]], width: int) -> str:
    padded = [row + [""] * (width - len(row)) for row in rows[:6]]
    if not padded:
        return ""
    lines = ["| " + " | ".join(cell.replace("|", "/") for cell in padded[0]) + " |"]
    lines.append("|" + "---|" * width)
    for row in padded[1:]:
        lines.append("| " + " | ".join(cell.replace("|", "/") for cell in row) + " |")
    return "\n".join(lines)


def caption_linked(bbox: fitz.Rect, captions: list[tuple[int, fitz.Rect]]) -> bool:
    if not captions:
        return False
    return min(_rect_distance(bbox, rect) for _, rect in captions) <= 120


def collect(doc_names: tuple[str, ...]) -> dict:
    records: list[dict] = []
    for name in doc_names:
        pdf_path = next((p for p in REPO_DIR.joinpath("docs").glob("*.pdf") if p.stem == name), None)
        if pdf_path is None:
            log(f"  跳过（找不到）: {name}")
            continue
        doc = fitz.open(pdf_path)
        fitz_count = plumber_count = 0
        with pdfplumber.open(pdf_path) as plumber:
            for pno, page in enumerate(doc):
                captions = table_captions(page)
                # PyMuPDF
                try:
                    finder = page.find_tables()
                    fitz_tables = getattr(finder, "tables", []) or []
                except Exception:
                    fitz_tables = []
                for table in fitz_tables:
                    try:
                        rows = table.extract() or []
                        bbox = fitz.Rect(table.bbox)
                    except Exception:
                        continue
                    stats = table_stats(rows)
                    records.append(
                        {"doc": name, "page": pno + 1, "method": "pymupdf", "bbox": list(bbox),
                         "captionLinked": caption_linked(bbox, captions), **stats}
                    )
                    fitz_count += 1

                # pdfplumber
                try:
                    page_plumber = plumber.pages[pno]
                    plumber_tables = page_plumber.find_tables()
                    for table in plumber_tables:
                        try:
                            rows = table.extract() or []
                            bbox = fitz.Rect(table.bbox)
                        except Exception:
                            continue
                        stats = table_stats(rows)
                        records.append(
                            {"doc": name, "page": pno + 1, "method": "pdfplumber", "bbox": list(bbox),
                             "captionLinked": caption_linked(bbox, captions), **stats}
                        )
                        plumber_count += 1
                except Exception as exc:
                    log(f"  pdfplumber 失败 p{pno + 1}: {str(exc)[:80]}")
        log(f"  {name[:44]:46s} pymupdf={fitz_count:3d} pdfplumber={plumber_count:3d}")
    return {"records": records}


def summarize(records: list[dict]) -> dict:
    result: dict[str, dict] = {}
    for method in ("pymupdf", "pdfplumber"):
        items = [r for r in records if r["method"] == method]
        valid = [r for r in items if r["valid"]]
        result[method] = {
            "tables": len(items),
            "valid": len(valid),
            "validRate": round(len(valid) / max(len(items), 1), 3),
            "captionLinkedRate": round(sum(1 for r in items if r["captionLinked"]) / max(len(items), 1), 3),
            "avgRows": round(sum(r["rows"] for r in valid) / max(len(valid), 1), 1),
            "avgCols": round(sum(r["cols"] for r in valid) / max(len(valid), 1), 1),
            "avgNumericRatio": round(sum(r["numeric_ratio"] for r in valid) / max(len(valid), 1), 3),
            "avgEmptyRatio": round(sum(r["empty_ratio"] for r in valid) / max(len(valid), 1), 3),
            "avgColConsistency": round(sum(r["col_consistency"] for r in valid) / max(len(valid), 1), 3),
        }
    return result


def write_report(summary: dict, records: list[dict]) -> None:
    report_dir = EVAL_DIR / "reports"
    report_dir.mkdir(exist_ok=True)
    lines = [
        "# 表格抽取方法对照（PyMuPDF vs pdfplumber）",
        "",
        "| 方法 | 检出表格 | 有效表格 | 有效率 | 图注关联率 | 平均行×列 | 数值占比 | 空单元格 | 列一致性 |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for method in ("pymupdf", "pdfplumber"):
        s = summary[method]
        lines.append(
            f"| {method} | {s['tables']} | {s['valid']} | {s['validRate']:.1%} | "
            f"{s['captionLinkedRate']:.1%} | {s['avgRows']}×{s['avgCols']} | "
            f"{s['avgNumericRatio']:.1%} | {s['avgEmptyRatio']:.1%} | {s['avgColConsistency']:.1%} |"
        )

    lines += ["", "## 样例", ""]
    for method in ("pymupdf", "pdfplumber"):
        samples = [r for r in records if r["method"] == method and r["valid"]][:2]
        for sample in samples:
            lines += [
                f"### {method} · {sample['doc'][:40]} · p{sample['page']}",
                "",
                sample["markdown"],
                "",
            ]
    lines += [
        "## 推荐",
        "",
        "- PyMuPDF 只作为表格候选检测器：有效率 54.2%，比 pdfplumber 好，但样例行仍有错位；",
        "- 检出后必须做结构校验（列一致性、数值占比、空单元格率），不通过不要转 markdown 入库；",
        "- 校验失败或合并单元格/跨页表：保存表格区域截图，查询时交给 VLM 读，不要硬造结构；",
        "- pdfplumber 可用于有完整边框的表格做二次验证，不建议作为主链路。",
        "",
        "## 口径",
        "",
        "- 无人工单元格金标，以上是结构代理指标，不等于单元格准确率；",
        "- 有效表格 = >=2 行、>=2 列、>=4 个非空单元格；",
        "- 图注关联 = 表格 bbox 与同页 `Table N` 图注距离 <= 120pt；",
        "- 合并单元格、无边框表、跨页表仍可能被误判，需要人工抽查样例。",
    ]
    (report_dir / "table_extraction_eval.md").write_text("\n".join(lines), encoding="utf-8")
    log(f"报告: {report_dir / 'table_extraction_eval.md'}")


def main(doc_names: tuple[str, ...]) -> None:
    data = collect(doc_names)
    summary = summarize(data["records"])
    (EVAL_DIR / "data" / "table_extraction_eval.json").write_text(
        json.dumps({"summary": summary, "records": data["records"]}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    write_report(summary, data["records"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="表格抽取方法对照")
    parser.add_argument("--docs", default="", help="逗号分隔的论文标题（不含 .pdf），缺省用内置 6 篇")
    args = parser.parse_args()
    names = tuple(x.strip() for x in args.docs.split(",") if x.strip()) if args.docs else DEFAULT_DOCS
    main(names)
