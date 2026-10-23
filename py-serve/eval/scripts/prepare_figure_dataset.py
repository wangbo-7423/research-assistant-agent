"""图表实验数据集准备：从 docs/ 抽取图注、引用句、图区域与裁剪图。

产出：
  eval/data/figure_elements.json   [{elementId, docId, docTitle, figureNo, caption,
                                      references, page, bbox, cropPath, bboxSource}]
  eval/data/figures/<docId>/fig_<n>.png
  eval/data/figure_desc.json       VLM 描述缓存（--describe 时生成）

检查项（先跑这个再跑检索实验）：
  - 图注识别率：`Figure N:` / `Figure N.` / `Figure N |` / `Fig. N`
  - 图区域定位率：栅格图用 image block；矢量图用 drawing 聚类
  - 正文引用句数量：0 引用 / 1 引用 / 多引用
  - 无法定位的图：单独列出，实验时标记为缺失而不是硬造

用法：
  python eval/scripts/prepare_figure_dataset.py
  python eval/scripts/prepare_figure_dataset.py --describe --limit 30

注意：修改 bbox 规则后，旧 figure_desc.json 会和新裁剪图不一致，
需要先删除 figure_desc.json、figure_queries.json、figure_vec_*.npy 再重跑。
"""
import argparse
import asyncio
import base64
import hashlib
import io
import json
import re
import sys
from collections import Counter
from pathlib import Path

import fitz
from PIL import Image

EVAL_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EVAL_DIR.parent.parent
sys.path.insert(0, str(EVAL_DIR))
sys.path.insert(0, str(EVAL_DIR / "scripts"))
sys.path.insert(0, str(EVAL_DIR.parent))

from common import DATA_DIR  # noqa: E402

from app.core.config import Config  # noqa: E402

DOCS_DIR = REPO_DIR / "docs"
FIG_DIR = DATA_DIR / "figures"
EXCLUDE_DOCS = ("面试题", "RLbook2020")

CAPTION_RE = re.compile(r"(?i)^\s*(?:figure|fig\.)\s*(\d+(?:\.\d+)?)\s*([:.|])\s*(.*)$")
MAX_REFS = 5
MAX_CAPTION_CHARS = 1200
MAX_REF_CHARS = 500


def stable_doc_id(title: str) -> str:
    return hashlib.md5(title.encode("utf-8")).hexdigest()[:16]


def log(message: str) -> None:
    print(message, flush=True)


def _rect_distance(a: fitz.Rect, b: fitz.Rect) -> float:
    if a.intersects(b):
        return 0.0
    dx = max(a.x0 - b.x1, b.x0 - a.x1, 0)
    dy = max(a.y0 - b.y1, b.y0 - a.y1, 0)
    return (dx * dx + dy * dy) ** 0.5


def _caption_blocks(page: fitz.Page) -> list[tuple[str, str, fitz.Rect]]:
    result = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        text = "".join(
            span.get("text", "")
            for line in block.get("lines", [])
            for span in line.get("spans", [])
        ).strip()
        match = CAPTION_RE.match(text)
        if not match:
            continue
        separator, rest = match.group(2), match.group(3).strip()
        # 区分图注与正文引用：正文常写成 "Figure 1.2 illustrates ..."（点号后小写动词）
        if separator == "." and rest and rest[0].islower():
            continue
        if len(rest) < 8:
            continue
        result.append((match.group(1), text[:MAX_CAPTION_CHARS], fitz.Rect(block["bbox"])))
    return result


def _pick_in_region(
    page: fitz.Page,
    caption_rect: fitz.Rect,
    image_rects: list[fitz.Rect],
    drawing_rects: list[fitz.Rect],
    region: fitz.Rect,
    prev_caption_bottom: float | None,
    next_caption_top: float | None,
) -> tuple[fitz.Rect | None, str]:
    page_rect = page.rect

    def in_region(rect: fitz.Rect) -> bool:
        return region.x0 <= (rect.x0 + rect.x1) / 2 <= region.x1

    near_images = [r for r in image_rects if r.width > 40 and r.height > 40 and in_region(r)]
    if near_images:
        best = min(near_images, key=lambda r: _rect_distance(caption_rect, r))
        if _rect_distance(caption_rect, best) <= 150:
            return best, "image"

    drawings = [
        r for r in drawing_rects
        if in_region(r)
        and (r.width >= 1 or r.height >= 1)
        and not (r.width > page_rect.width * 0.8 and r.height > page_rect.height * 0.5)
    ]
    above_floor = max(caption_rect.y0 - 450, (prev_caption_bottom or 0) + 4)
    above = [
        r for r in drawings
        if r.y1 <= caption_rect.y0 + 6 and r.y0 >= above_floor
    ]
    below_ceiling = min(caption_rect.y1 + 450, (next_caption_top or page_rect.height) - 4)
    below = [
        r for r in drawings
        if r.y0 >= caption_rect.y1 - 6 and r.y1 <= below_ceiling
    ]
    side = above if len(above) >= len(below) else below
    if side:
        union = fitz.Rect(
            min(r.x0 for r in side),
            min(r.y0 for r in side),
            max(r.x1 for r in side),
            max(r.y1 for r in side),
        ) & page_rect
        if union.width > 40 and union.height > 40:
            return union, "drawing"
    return None, "none"


def _pick_bbox(
    page: fitz.Page,
    caption_rect: fitz.Rect,
    image_rects: list[fitz.Rect],
    drawing_rects: list[fitz.Rect],
    prev_caption_bottom: float | None = None,
    next_caption_top: float | None = None,
) -> tuple[fitz.Rect | None, str]:
    """确定图区域：先在本栏找，找不到再退到整页（通栏/跨栏图）。"""
    page_rect = page.rect
    if caption_rect.width > page_rect.width * 0.6:
        preferred = page_rect
    elif (caption_rect.x0 + caption_rect.x1) / 2 < page_rect.width / 2:
        preferred = fitz.Rect(0, 0, page_rect.width / 2, page_rect.height)
    else:
        preferred = fitz.Rect(page_rect.width / 2, 0, page_rect.width, page_rect.height)

    result = _pick_in_region(
        page, caption_rect, image_rects, drawing_rects, preferred,
        prev_caption_bottom, next_caption_top,
    )
    if result[0] is not None:
        return result
    return _pick_in_region(
        page, caption_rect, image_rects, drawing_rects, page_rect,
        prev_caption_bottom, next_caption_top,
    )


def _crop(page: fitz.Page, rect: fitz.Rect, target: Path) -> bool:
    try:
        pix = page.get_pixmap(clip=rect, dpi=150, alpha=False)
        image = Image.open(io.BytesIO(pix.tobytes("png")))
        image.thumbnail((1400, 1400))
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target)
        return True
    except Exception as exc:
        log(f"    裁剪失败: {exc}")
        return False


def _find_references(text: str, figure_no: str, caption: str) -> list[str]:
    pattern = re.compile(rf"(?i)\bfig(?:ure)?\.?\s*{re.escape(figure_no)}(?![\d.])")
    parent = re.compile(r"(?i)\bof\s*\[\d+\]|\bin\s*\[\d+\]|\bfrom\s*\[\d+\]")
    snippets: list[str] = []
    seen: set[str] = set()
    for match in pattern.finditer(text):
        start = max(
            text.rfind(".", 0, match.start()),
            text.rfind("!", 0, match.start()),
            text.rfind("?", 0, match.start()),
            text.rfind("\n\n", 0, match.start()),
        )
        end = min(
            [pos for pos in (text.find(".", match.end()), text.find("!", match.end()),
                             text.find("?", match.end())) if pos != -1] or [match.end() + 200]
        )
        sentence = text[start + 1:end + 1].strip().replace("\n", " ")
        if len(sentence) < 20 or len(sentence) > MAX_REF_CHARS:
            continue
        if sentence.startswith(caption[:30]):
            continue
        if parent.search(sentence):
            # 跨论文引用（Figure 2 of [12]）不能链接到本文的图
            continue
        if sentence in seen:
            continue
        seen.add(sentence)
        snippets.append(sentence)
        if len(snippets) >= MAX_REFS:
            break
    return snippets


def build_elements(describe: bool, limit: int, vl_model: str) -> list[dict]:
    corpus_path = DATA_DIR / "attr_corpus.json"
    corpus = json.loads(corpus_path.read_text(encoding="utf-8")) if corpus_path.exists() else {"docs": []}
    text_by_title = {doc["title"]: doc["text"] for doc in corpus["docs"]}

    elements: list[dict] = []
    for pdf in sorted(DOCS_DIR.glob("*.pdf")):
        if any(x in pdf.name for x in EXCLUDE_DOCS):
            continue
        title = pdf.stem
        doc_id = stable_doc_id(title)
        full_text = text_by_title.get(title, "")
        doc = fitz.open(pdf)
        counter: Counter[str] = Counter()
        doc_elements = 0

        for pno, page in enumerate(doc):
            captions = _caption_blocks(page)
            if not captions:
                continue
            blocks = page.get_text("dict").get("blocks", [])
            image_rects = [
                fitz.Rect(b["bbox"]) for b in blocks if b.get("type") == 1 and b.get("bbox")
            ]
            try:
                drawing_rects = [fitz.Rect(d["rect"]) for d in page.get_drawings()]
            except Exception:
                drawing_rects = []

            captions = sorted(captions, key=lambda item: item[2].y0)
            for cap_index, (figure_no, caption, rect) in enumerate(captions):
                counter[figure_no] += 1
                suffix = "" if counter[figure_no] == 1 else f"-{counter[figure_no]}"
                element_id = f"{doc_id}#f{figure_no}{suffix}"

                # 同页堆叠多图时，用相邻图注限定本图的上下边界，避免把上一张图也裁进来
                prev_bottom = next_top = None
                if cap_index > 0:
                    prev = captions[cap_index - 1][2]
                    if min(rect.x1, prev.x1) > max(rect.x0, prev.x0):
                        prev_bottom = prev.y1
                if cap_index + 1 < len(captions):
                    nxt = captions[cap_index + 1][2]
                    if min(rect.x1, nxt.x1) > max(rect.x0, nxt.x0):
                        next_top = nxt.y0

                bbox, source = _pick_bbox(
                    page, rect, image_rects, drawing_rects, prev_bottom, next_top
                )
                crop_path = ""
                if bbox is not None:
                    target = FIG_DIR / doc_id / f"fig_{figure_no}{suffix}.png"
                    if _crop(page, bbox, target):
                        crop_path = str(target.relative_to(EVAL_DIR))
                references = _find_references(full_text, figure_no, caption) if full_text else []
                elements.append(
                    {
                        "elementId": element_id,
                        "docId": doc_id,
                        "docTitle": title,
                        "figureNo": figure_no,
                        "caption": caption,
                        "references": references,
                        "page": pno + 1,
                        "bbox": [round(v, 1) for v in bbox] if bbox else None,
                        "bboxSource": source,
                        "cropPath": crop_path,
                    }
                )
                doc_elements += 1
        log(f"  {title[:46]:48s} figures={doc_elements:3d}")

    log(f"合计图元素: {len(elements)}")

    # 数据集体检
    no_bbox = [e for e in elements if not e["bbox"]]
    no_crop = [e for e in elements if not e["cropPath"]]
    no_refs = [e for e in elements if not e["references"]]
    ref_counts = Counter(len(e["references"]) for e in elements)
    log("体检：")
    log(f"  有 bbox: {len(elements) - len(no_bbox)}/{len(elements)}；有裁剪图: {len(elements) - len(no_crop)}")
    log(f"  无正文引用: {len(no_refs)}/{len(elements)}；引用句分布: {dict(sorted(ref_counts.items()))}")
    if no_bbox:
        log(f"  无法定位的图: {[e['elementId'] for e in no_bbox][:10]}")

    out_path = DATA_DIR / "figure_elements.json"
    out_path.write_text(json.dumps(elements, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"保存: {out_path}")

    if describe:
        asyncio.run(describe_elements(elements, limit, vl_model))
    return elements


async def describe_elements(elements: list[dict], limit: int, vl_model: str) -> None:
    cache_path = DATA_DIR / "figure_desc.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    targets = [e for e in elements if e["cropPath"] and e["elementId"] not in cache]
    if limit:
        targets = targets[:limit]
    log(f"生成 {len(targets)} 张图的 VLM 描述（{vl_model}）...")

    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=Config.QWEN_API_KEY, base_url=Config.QWEN_BASE_URL, timeout=120)
    sem = asyncio.Semaphore(3)
    prompt = (
        "你在描述一篇论文中的图。只描述图中确实可见的内容：\n"
        "1. 图的类型（折线/柱状/架构图/示意图/截图）；\n"
        "2. 坐标轴、图例、分组；\n"
        "3. 可读出的关键数值或趋势（不确定就写“约”“无法精确读取”）；\n"
        "4. 不要补充图外知识，不要推断作者结论。\n"
        "输出 200~400 字中文描述。"
    )

    async def one(element: dict) -> None:
        path = EVAL_DIR / element["cropPath"]
        b64 = base64.b64encode(path.read_bytes()).decode()
        async with sem:
            try:
                response = await client.chat.completions.create(
                    model=vl_model,
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                                {"type": "text", "text": prompt},
                            ],
                        }
                    ],
                    temperature=0.2,
                    max_tokens=500,
                )
                cache[element["elementId"]] = response.choices[0].message.content or ""
                log(f"  described {element['elementId']}")
            except Exception as exc:
                log(f"  VLM 失败 {element['elementId']}: {str(exc)[:160]}")

    await asyncio.gather(*(one(e) for e in targets))
    cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"描述缓存: {cache_path}（{len(cache)} 条）")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="准备图表实验数据集")
    parser.add_argument("--describe", action="store_true", help="调用视觉模型生成图描述")
    parser.add_argument("--limit", type=int, default=0, help="只描述前 N 张图")
    parser.add_argument("--vl-model", default="qwen3-vl-plus", help="DashScope 视觉模型名")
    args = parser.parse_args()
    build_elements(args.describe, args.limit, args.vl_model)
