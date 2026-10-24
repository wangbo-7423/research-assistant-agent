"""图表抽取质量对照：不同 bbox 策略到底裁得准不准。

比较 5 种图区域定位方法：
  image   只取最近的栅格图块
  drawing 只对矢量 drawing 做上下簇聚类
  hybrid  image → drawing（当前 prepare_figure_dataset 使用的方法）
  band    图注同栏的固定上下 band（不依赖 drawing）
  page    整页（作为 VLM 读图兜底，不追求裁剪精度）

自动指标（无需人工标注）：
  text_ratio        裁剪区域内“正文段落文本块”覆盖面积占比（越低越好）
  body_text         正文污染率 > 12%
  adjacent_caption  裁到了同一页相邻图注
  blank             非白像素 < 1%（空图/裁错）
  page_like         裁剪面积 > 70% 页面（退化成整页）

可选 VLM 判定：
  qwen3-vl-plus 看裁剪图，回答 4 个问题（单图/含正文/含相邻图/完整），
  抽样 20 个元素做人工替代性检查。

用法：
  python eval/scripts/eval_figure_extraction.py
  python eval/scripts/eval_figure_extraction.py --judge
"""
import argparse
import asyncio
import base64
import io
import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

import fitz
from PIL import Image

EVAL_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EVAL_DIR.parent.parent
sys.path.insert(0, str(EVAL_DIR))
sys.path.insert(0, str(EVAL_DIR / "scripts"))
sys.path.insert(0, str(EVAL_DIR.parent))

from common import DATA_DIR  # noqa: E402
from prepare_figure_dataset import (  # noqa: E402
    CAPTION_RE,
    EXCLUDE_DOCS,
    _caption_blocks,
    _pick_bbox,
    _pick_in_region,
    _rect_distance,
    stable_doc_id,
)
from app.core.config import Config  # noqa: E402

OUT_DIR = DATA_DIR / "figure_extraction_eval"
METHODS = ("image", "drawing", "hybrid", "band", "page")
JUDGE_METHODS = ("image", "drawing", "hybrid", "band", "page")
MAX_JUDGE = 20
SEED = 42


def log(message: str) -> None:
    print(message, flush=True)


def _column(page: fitz.Page, caption: fitz.Rect) -> fitz.Rect:
    if caption.width > page.rect.width * 0.6:
        return page.rect
    if (caption.x0 + caption.x1) / 2 < page.rect.width / 2:
        return fitz.Rect(0, 0, page.rect.width / 2, page.rect.height)
    return fitz.Rect(page.rect.width / 2, 0, page.rect.width, page.rect.height)


def _image_bbox(page: fitz.Page, caption: fitz.Rect, image_rects: list[fitz.Rect]) -> fitz.Rect | None:
    column = _column(page, caption)
    candidates = [
        r for r in image_rects
        if r.width > 40 and r.height > 40
        and column.x0 <= (r.x0 + r.x1) / 2 <= column.x1
    ]
    if not candidates:
        return None
    best = min(candidates, key=lambda r: _rect_distance(caption, r))
    return best if _rect_distance(caption, best) <= 150 else None


def _drawing_bbox(page: fitz.Page, caption: fitz.Rect, drawings: list[fitz.Rect]) -> fitz.Rect | None:
    column = _column(page, caption)
    bbox, source = _pick_in_region(page, caption, [], drawings, column, None, None)
    if bbox is None:
        bbox, source = _pick_in_region(page, caption, [], drawings, page.rect, None, None)
    return bbox if source == "drawing" else None


def _band_bbox(page: fitz.Page, caption: fitz.Rect, drawings: list[fitz.Rect]) -> fitz.Rect | None:
    """图注同栏的固定上下 band：不挑 drawing，直接按版面切一块。"""
    column = _column(page, caption)
    above = [r for r in drawings if r.y1 <= caption.y0 and r.y0 >= caption.y0 - 450]
    below = [r for r in drawings if r.y0 >= caption.y1 and r.y1 <= caption.y1 + 450]
    if len(above) >= len(below):
        rect = fitz.Rect(column.x0, max(column.y0, caption.y0 - 450), column.x1, max(column.y0, caption.y0 - 5))
    else:
        rect = fitz.Rect(column.x0, min(column.y1, caption.y1 + 5), column.x1, min(column.y1, caption.y1 + 450))
    return rect if rect.width > 40 and rect.height > 40 else None


def _render(page: fitz.Page, rect: fitz.Rect, target: Path) -> bool:
    try:
        pix = page.get_pixmap(clip=rect, dpi=120, alpha=False)
        image = Image.open(io.BytesIO(pix.tobytes("png")))
        image.thumbnail((1200, 1200))
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target)
        return True
    except Exception as exc:
        log(f"    渲染失败 {target.name}: {exc}")
        return False


def _ink_ratio(path: Path) -> float:
    try:
        image = Image.open(path).convert("L")
        image.thumbnail((200, 200))
        pixels = list(image.getdata())
        if not pixels:
            return 0.0
        return sum(1 for p in pixels if p < 245) / len(pixels)
    except Exception:
        return 0.0


def _body_text_ratio(page: fitz.Page, crop: fitz.Rect, captions: list[fitz.Rect]) -> float:
    area = crop.width * crop.height
    if area <= 0:
        return 0.0
    covered = 0.0
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        text = "".join(
            span.get("text", "") for line in block.get("lines", []) for span in line.get("spans", [])
        ).strip()
        # 图内标签/坐标轴文字较短，只统计像正文段落的长块
        if len(text) < 80:
            continue
        rect = fitz.Rect(block["bbox"])
        if any(rect.intersects(c) for c in captions):
            continue
        inter = rect & crop
        if inter.is_empty:
            continue
        covered += inter.width * inter.height
    return min(covered / area, 1.0)


def extract_all() -> list[dict]:
    elements: list[dict] = []
    for pdf in sorted(REPO_DIR.joinpath("docs").glob("*.pdf")):
        if any(x in pdf.name for x in EXCLUDE_DOCS):
            continue
        title = pdf.stem
        doc_id = stable_doc_id(title)
        doc = fitz.open(pdf)
        counter: Counter[str] = Counter()
        for pno, page in enumerate(doc):
            captions = sorted(_caption_blocks(page), key=lambda item: item[2].y0)
            if not captions:
                continue
            blocks = page.get_text("dict").get("blocks", [])
            image_rects = [fitz.Rect(b["bbox"]) for b in blocks if b.get("type") == 1 and b.get("bbox")]
            try:
                drawings = [fitz.Rect(d["rect"]) for d in page.get_drawings()]
            except Exception:
                drawings = []
            caption_rects = [item[2] for item in captions]

            for index, (figure_no, caption, rect) in enumerate(captions):
                counter[figure_no] += 1
                suffix = "" if counter[figure_no] == 1 else f"-{counter[figure_no]}"
                element_id = f"{doc_id}#f{figure_no}{suffix}"
                variants = {
                    "image": _image_bbox(page, rect, image_rects),
                    "drawing": _drawing_bbox(page, rect, drawings),
                    "hybrid": _pick_bbox(page, rect, image_rects, drawings)[0],
                    "band": _band_bbox(page, rect, drawings),
                    "page": page.rect,
                }
                record = {
                    "elementId": element_id,
                    "docId": doc_id,
                    "docTitle": title,
                    "figureNo": figure_no,
                    "caption": caption[:200],
                    "page": pno + 1,
                    "variants": {},
                }
                for method, bbox in variants.items():
                    item = {"bbox": None, "cropPath": None}
                    if bbox is not None:
                        target = OUT_DIR / method / f"{element_id}.png"
                        if _render(page, bbox, target):
                            item["bbox"] = [round(v, 1) for v in bbox]
                            item["cropPath"] = str(target.relative_to(EVAL_DIR))
                            item["text_ratio"] = round(_body_text_ratio(page, bbox, caption_rects), 3)
                            item["ink_ratio"] = round(_ink_ratio(target), 3)
                            item["page_like"] = (bbox.width * bbox.height) / (page.rect.width * page.rect.height) > 0.7
                            item["adjacent_caption"] = any(
                                other is not rect and bbox.intersects(other) for other in caption_rects
                            )
                    record["variants"][method] = item
                elements.append(record)
        log(f"  {title[:44]:46s} figures={sum(1 for e in elements if e['docId'] == doc_id):3d}")
    return elements


def summarize(elements: list[dict]) -> dict:
    result: dict[str, dict] = {}
    for method in METHODS:
        items = [e["variants"][method] for e in elements]
        present = [x for x in items if x["bbox"]]
        n = len(items)
        clean = [
            x for x in present
            if x.get("text_ratio", 0) <= 0.12
            and not x.get("adjacent_caption")
            and x.get("ink_ratio", 1) >= 0.01
        ]
        result[method] = {
            "coverage": round(len(present) / max(n, 1), 4),
            "cleanRate": round(len(clean) / max(len(present), 1), 4),
            "avg_text_ratio": round(sum(x.get("text_ratio", 0) for x in present) / max(len(present), 1), 4),
            "body_text_rate": round(
                sum(1 for x in present if x.get("text_ratio", 0) > 0.12) / max(len(present), 1), 4
            ),
            "adjacent_caption_rate": round(
                sum(1 for x in present if x.get("adjacent_caption")) / max(len(present), 1), 4
            ),
            "blank_rate": round(
                sum(1 for x in present if x.get("ink_ratio", 1) < 0.01) / max(len(present), 1), 4
            ),
            "page_like_rate": round(
                sum(1 for x in present if x.get("page_like")) / max(len(present), 1), 4
            ),
            "n": n,
        }
    return result


async def judge_sample(elements: list[dict]) -> dict:
    cache_path = DATA_DIR / "figure_extraction_judge.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    rng = random.Random(SEED)
    sample = rng.sample(elements, min(MAX_JUDGE, len(elements)))

    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=Config.QWEN_API_KEY, base_url=Config.QWEN_BASE_URL, timeout=120)
    sem = asyncio.Semaphore(3)
    prompt = (
        "你在检查论文图表的裁剪质量。请只根据图片判断，输出 JSON：\n"
        '{"single_figure": true/false, "includes_body_text": true/false, '
        '"includes_other_figure": true/false, "complete": true/false}\n'
        "single_figure=图中是否只有一个图/表；includes_body_text=是否包含大段正文；"
        "includes_other_figure=是否包含另一张图；complete=目标图是否完整未被截断。"
    )

    async def one(element: dict, method: str) -> None:
        item = element["variants"][method]
        if not item.get("cropPath"):
            return
        key = f"{element['elementId']}::{method}"
        if key in cache:
            return
        b64 = base64.b64encode((EVAL_DIR / item["cropPath"]).read_bytes()).decode()
        async with sem:
            try:
                response = await client.chat.completions.create(
                    model="qwen3-vl-plus",
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                                {"type": "text", "text": prompt},
                            ],
                        }
                    ],
                    temperature=0,
                    max_tokens=120,
                )
                raw = response.choices[0].message.content or ""
                start, end = raw.find("{"), raw.rfind("}")
                cache[key] = json.loads(raw[start : end + 1]) if start >= 0 and end > start else {}
            except Exception as exc:
                log(f"  judge 失败 {key}: {str(exc)[:100]}")

    tasks = [one(e, m) for e in sample for m in JUDGE_METHODS]
    log(f"VLM 判定：{len(tasks)} 次（抽样 {len(sample)} 个图 × {len(JUDGE_METHODS)} 方法）...")
    await asyncio.gather(*tasks)
    cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")

    summary: dict[str, dict] = {}
    for method in JUDGE_METHODS:
        values = [
            cache[f"{e['elementId']}::{method}"]
            for e in sample
            if f"{e['elementId']}::{method}" in cache and cache[f"{e['elementId']}::{method}"]
        ]
        n = len(values)
        summary[method] = {
            "n": n,
            "single_figure": round(sum(1 for v in values if v.get("single_figure")) / max(n, 1), 3),
            "no_body_text": round(sum(1 for v in values if not v.get("includes_body_text")) / max(n, 1), 3),
            "no_other_figure": round(sum(1 for v in values if not v.get("includes_other_figure")) / max(n, 1), 3),
            "complete": round(sum(1 for v in values if v.get("complete")) / max(n, 1), 3),
        }
    return summary


def write_report(elements: list[dict], summary: dict, judge: dict | None) -> None:
    report_dir = EVAL_DIR / "reports"
    report_dir.mkdir(exist_ok=True)
    lines = [
        "# 图表区域抽取方法对照",
        "",
        f"- 图注样本：{len(elements)} 个（14 篇论文）",
        "- 方法：image（栅格块）/ drawing（矢量簇）/ hybrid（当前）/ band（固定版面带）/ page（整页）",
        "",
        "## 自动指标",
        "",
        "| 方法 | 覆盖率 | 干净裁剪率 | 平均正文占比 | 正文污染率 | 相邻图注污染 | 空图率 | 整页率 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for method in METHODS:
        s = summary[method]
        lines.append(
            f"| {method} | {s['coverage']:.1%} | {s['cleanRate']:.1%} | {s['avg_text_ratio']:.1%} | "
            f"{s['body_text_rate']:.1%} | {s['adjacent_caption_rate']:.1%} | "
            f"{s['blank_rate']:.1%} | {s['page_like_rate']:.1%} |"
        )
    if judge:
        lines += [
            "",
            "## VLM 抽查（越高越好）",
            "",
            "| 方法 | 单图率 | 无正文污染 | 无相邻图 | 完整率 |",
            "|---|---|---|---|---|",
        ]
        for method in JUDGE_METHODS:
            s = judge.get(method)
            if not s:
                continue
            lines.append(
                f"| {method} | {s['single_figure']:.1%} | {s['no_body_text']:.1%} | "
                f"{s['no_other_figure']:.1%} | {s['complete']:.1%} |"
            )
    lines += [
        "",
        "## 推荐",
        "",
        "- 栅格图：直接用 image block（精度最高）；",
        "- 矢量图：用 hybrid 候选，但必须做校验——正文占比 > 12% 或撞相邻图注，判为低置信度；",
        "- 低置信度不生成 VLM 描述，只保留 caption + page，精确问题改用整页/区域图交给 VLM 读；",
        "- `band` 和 `page` 只适合 VLM 读图兜底，不适合生成描述建索引；",
        "- 表格不要直接转 markdown：PyMuPDF 只当候选检测器，结构校验失败就退回表格截图 + VLM。",
        "",
        "## 口径",
        "",
        "- `正文污染率` = 裁剪区域内长正文文本块（>80 字）面积占比 > 12% 的图占比；",
        "- `相邻图注污染` = 裁剪区域与同页另一条图注相交；",
        "- `空图率` = 非白像素 < 1%；`整页率` = 面积超过页面 70%；",
        "- 这些是自动代理指标，不是人工 bbox IoU；VLM 抽查也有模型偏置，只能做方向性判断。",
    ]
    (report_dir / "figure_extraction_eval.md").write_text("\n".join(lines), encoding="utf-8")
    log(f"报告: {report_dir / 'figure_extraction_eval.md'}")


def main(judge: bool) -> None:
    log("抽取各方法的图区域 ...")
    elements = extract_all()
    summary = summarize(elements)
    judge_summary = asyncio.run(judge_sample(elements)) if judge else None
    (DATA_DIR / "figure_extraction_eval.json").write_text(
        json.dumps({"summary": summary, "judge": judge_summary, "elements": elements}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    write_report(elements, summary, judge_summary)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="图表区域抽取方法对照")
    parser.add_argument("--judge", action="store_true", help="抽样调用 qwen3-vl-plus 判定裁剪质量")
    args = parser.parse_args()
    main(args.judge)
