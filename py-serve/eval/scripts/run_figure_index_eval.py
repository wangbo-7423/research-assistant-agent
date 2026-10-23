"""图表召回实验：只靠图注 vs 加正文引用 vs 加 VLM 描述 vs 全都要。

数据来源：
  - eval/data/figure_elements.json  （prepare_figure_dataset.py 产出，含 caption/refs/bbox/crop）
  - eval/data/figure_desc.json      （VLM 图描述缓存）
  - eval/data/attr_corpus.json      （与 chunk 实验同一批 14 篇论文的正文 chunk）
  - eval/data/attr_chunk_vectors.npy

实验臂（每个图元素的索引文本）：
  A caption             仅图注
  B caption+refs        图注 + 正文中指向该图的引用句
  C caption+desc        图注 + VLM 描述
  D caption+refs+desc   全都要

查询来源：
  ref      从正文引用句改写（不出现图号）
  caption  从图注改写（不出现图号）
  visual   直接看图生成（qwen3-vl-plus，不出现图号；排除文字型图）

指标：
  ElementRecall@5   金标图元素是否进 top5
  MRR@5
  CaptionChunkRecall@5  现有正文 chunk（含图注的块）是否进 top5，作为“当前生产能否间接召回”的参照

用法：
  python eval/scripts/run_figure_index_eval.py
  python eval/scripts/run_figure_index_eval.py --rebuild-queries
"""
import argparse
import asyncio
import base64
import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from openai import AsyncOpenAI

EVAL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(EVAL_DIR))
sys.path.insert(0, str(EVAL_DIR / "scripts"))
sys.path.insert(0, str(EVAL_DIR.parent))

from common import DATA_DIR, ds_chat, embed_texts, parse_json_object, rrf_fuse  # noqa: E402

from app.core.config import Config  # noqa: E402

TOP_K = 5
CANDIDATE_K = 20
VISUAL_LIMIT = 60
CONCURRENCY = 6
SEED = 42

ARMS = ("A_caption", "B_caption_refs", "C_caption_desc", "D_all")
SOURCE_LABEL = {"ref": "正文引用", "caption": "图注", "visual": "看图提问"}

TEXTBOX_RE = re.compile(
    r"(?i)\b(excerpt|instructions?|prompt|labeler|completion|news article|transcript|dialogue)\b"
)

REF_QUERY_PROMPT = """下面是一篇论文正文中指向某张图的句子。请把它改写成用户会向科研助手提出的问题。
要求：
1. 保留原意，口语化；
2. 不要出现“图 1”“Figure 2”这类图号；
3. 只输出 JSON：{"query": "..."}"""

CAPTION_QUERY_PROMPT = """下面是一张论文图片的图注。请把它改写成用户会向科研助手提出的问题。
要求：
1. 保留图注表达的核心信息，口语化；
2. 不要出现“图 1”“Figure 2”这类图号；
3. 只输出 JSON：{"query": "..."}"""

VISUAL_QUERY_PROMPT = """你在模拟科研助手用户。下面是一篇论文中的一张图。请生成 1 个用户会问的、必须看图才能回答的问题。
要求：
1. 问图中可见的趋势、结构、数值、对比等；
2. 不要出现“图 1”“Figure 2”这类图号；
3. 只输出 JSON：{"query": "..."}"""


def log(message: str) -> None:
    print(message, flush=True)


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


def load_elements() -> tuple[list[dict], dict[str, str]]:
    elements = json.loads((DATA_DIR / "figure_elements.json").read_text(encoding="utf-8"))
    desc_path = DATA_DIR / "figure_desc.json"
    descriptions = (
        json.loads(desc_path.read_text(encoding="utf-8")) if desc_path.exists() else {}
    )
    usable = [e for e in elements if e.get("cropPath") and descriptions.get(e["elementId"])]
    for element in usable:
        element["description"] = descriptions[element["elementId"]]
        element["isTextbox"] = bool(TEXTBOX_RE.search(element["caption"]))
    return usable, descriptions


def caption_chunk_map(elements: list[dict]) -> tuple[dict[str, str], dict[str, dict]]:
    corpus = json.loads((DATA_DIR / "attr_corpus.json").read_text(encoding="utf-8"))
    chunks_by_doc: dict[str, list[dict]] = defaultdict(list)
    for chunk in corpus["chunks"]:
        chunks_by_doc[chunk["docId"]].append(chunk)

    mapping: dict[str, str] = {}
    for element in elements:
        candidates = chunks_by_doc.get(element["docId"], [])
        for size in (60, 40, 24):
            probe = normalize(element["caption"][:size])
            if len(probe) < 12:
                continue
            hit = next((c for c in candidates if probe in normalize(c["text"])), None)
            if hit:
                mapping[element["elementId"]] = hit["chunkKey"]
                break
    return mapping, {c["chunkKey"]: c for c in corpus["chunks"]}


async def generate_queries(elements: list[dict], rebuild: bool) -> list[dict]:
    cache_path = DATA_DIR / "figure_queries.json"
    if cache_path.exists() and not rebuild:
        queries = json.loads(cache_path.read_text(encoding="utf-8"))
        valid = {e["elementId"] for e in elements}
        queries = [q for q in queries if q["elementId"] in valid]
        log(f"载入缓存查询: {len(queries)} 条")
        return queries

    sem = asyncio.Semaphore(CONCURRENCY)
    queries: list[dict] = []

    async def text_query(element: dict, source: str, text: str, system: str) -> None:
        try:
            raw = await ds_chat(
                Config.DEEPSEEK_MODEL,
                system,
                f"【文档】{element['docTitle']}\n【文字】{text[:1200]}",
                0.6,
                sem,
            )
            query = parse_json_object(raw).get("query", "")
        except Exception as exc:
            log(f"  查询生成失败 {element['elementId']}/{source}: {exc}")
            return
        if isinstance(query, str) and query.strip() and not re.search(
            r"(?i)(figure|fig\.?|图)\s*\d", query
        ):
            queries.append(
                {
                    "queryId": f"{element['elementId']}::{source}",
                    "elementId": element["elementId"],
                    "source": source,
                    "query": query.strip(),
                }
            )

    tasks = []
    for element in elements:
        if element["references"]:
            longest = max(element["references"], key=len)
            tasks.append(text_query(element, "ref", longest, REF_QUERY_PROMPT))
        tasks.append(text_query(element, "caption", element["caption"], CAPTION_QUERY_PROMPT))
    log(f"生成引用/图注查询: {len(tasks)} ...")
    await asyncio.gather(*tasks)

    # 看图提问：只用非文字型图，控制数量
    visual_targets = [e for e in elements if not e["isTextbox"]]
    random.Random(SEED).shuffle(visual_targets)
    visual_targets = visual_targets[:VISUAL_LIMIT]
    log(f"生成看图查询: {len(visual_targets)} 张 ...")

    client = AsyncOpenAI(api_key=Config.QWEN_API_KEY, base_url=Config.QWEN_BASE_URL, timeout=120)
    vsem = asyncio.Semaphore(3)

    async def visual_query(element: dict) -> None:
        path = EVAL_DIR / element["cropPath"]
        b64 = base64.b64encode(path.read_bytes()).decode()
        async with vsem:
            try:
                response = await client.chat.completions.create(
                    model="qwen3-vl-plus",
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                                {"type": "text", "text": VISUAL_QUERY_PROMPT},
                            ],
                        }
                    ],
                    temperature=0.6,
                    max_tokens=200,
                )
                raw = response.choices[0].message.content or ""
                query = parse_json_object(raw).get("query", "")
            except Exception as exc:
                log(f"  看图查询失败 {element['elementId']}: {str(exc)[:120]}")
                return
        if isinstance(query, str) and query.strip() and not re.search(
            r"(?i)(figure|fig\.?|图)\s*\d", query
        ):
            queries.append(
                {
                    "queryId": f"{element['elementId']}::visual",
                    "elementId": element["elementId"],
                    "source": "visual",
                    "query": query.strip(),
                }
            )

    await asyncio.gather(*(visual_query(e) for e in visual_targets))
    cache_path.write_text(json.dumps(queries, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"查询总数 {len(queries)}（缓存 {cache_path}）")
    return queries


def arm_texts(element: dict, arm: str) -> str:
    refs = "\n".join(element["references"][:5])
    if arm == "A_caption":
        text = element["caption"]
    elif arm == "B_caption_refs":
        text = element["caption"] + ("\n" + refs if refs else "")
    elif arm == "C_caption_desc":
        text = element["caption"] + "\n" + element["description"]
    else:
        text = element["caption"] + ("\n" + refs if refs else "") + "\n" + element["description"]
    return text[:2400]


async def arm_vectors(elements: list[dict], arm: str) -> np.ndarray:
    path = DATA_DIR / f"figure_vec_{arm}.npy"
    if path.exists():
        vectors = np.load(path)
        if vectors.shape[0] == len(elements):
            return vectors
    log(f"向量化 {arm}: {len(elements)} 个图元素 ...")
    vectors = await embed_texts([arm_texts(e, arm) for e in elements])
    np.save(path, vectors)
    return vectors


async def main(rebuild_queries: bool) -> None:
    elements, _ = load_elements()
    log(f"可用图元素（有裁剪+描述）: {len(elements)}")
    textbox = sum(1 for e in elements if e["isTextbox"])
    refs0 = sum(1 for e in elements if not e["references"])
    log(f"其中文字型图 {textbox}，无正文引用 {refs0}")

    queries = await generate_queries(elements, rebuild_queries)
    by_source = Counter(q["source"] for q in queries)
    log(f"查询分布: {dict(by_source)}")

    query_vectors = await embed_texts([q["query"] for q in queries])
    corpus = json.loads((DATA_DIR / "attr_corpus.json").read_text(encoding="utf-8"))
    chunk_vectors = np.load(DATA_DIR / "attr_chunk_vectors.npy")
    chunk_keys = [c["chunkKey"] for c in corpus["chunks"]]
    cap_map, _ = caption_chunk_map(elements)

    element_by_id = {e["elementId"]: e for e in elements}
    element_ids = [e["elementId"] for e in elements]

    results: dict[str, dict[str, dict]] = {}
    details: list[dict] = []
    rankings_by_arm: dict[str, dict[str, list[str]]] = {}

    def summarize(arm: str, rankings: dict[str, list[str]]) -> None:
        per_source: dict[str, list[dict]] = defaultdict(list)
        for query in queries:
            ranked = rankings[query["queryId"]]
            gold = query["elementId"]
            rank = ranked.index(gold) + 1 if gold in ranked else 0
            caption_chunk = cap_map.get(gold)
            caption_rank = (
                ranked.index(caption_chunk) + 1 if caption_chunk and caption_chunk in ranked else 0
            )
            record = {
                **query,
                "arm": arm,
                "elementRank": rank,
                "captionChunkRank": caption_rank,
                "top1": ranked[0] if ranked else "",
            }
            per_source[query["source"]].append(record)
            details.append(record)

        results[arm] = {}
        for source, items in per_source.items():
            n = len(items)
            results[arm][source] = {
                "n": n,
                "elementRecall@1": round(sum(1 for x in items if x["elementRank"] == 1) / n, 4),
                "elementRecall@5": round(sum(1 for x in items if 0 < x["elementRank"] <= 5) / n, 4),
                "mrr@5": round(sum(1 / x["elementRank"] for x in items if x["elementRank"] > 0) / n, 4),
                "captionChunkRecall@5": round(
                    sum(1 for x in items if 0 < x["captionChunkRank"] <= 5) / n, 4
                ),
            }
        log(f"{arm} 完成")

    ids = chunk_keys + element_ids
    scores_by_arm: dict[str, np.ndarray] = {}

    for arm in ARMS:
        vectors = await arm_vectors(elements, arm)
        matrix = np.vstack([chunk_vectors, vectors])
        norm = matrix / (np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-9)
        qnorm = query_vectors / (np.linalg.norm(query_vectors, axis=1, keepdims=True) + 1e-9)
        scores = qnorm @ norm.T
        scores_by_arm[arm] = scores
        rankings: dict[str, list[str]] = {}
        for index, query in enumerate(queries):
            order = np.argsort(-scores[index])[:CANDIDATE_K]
            rankings[query["queryId"]] = [ids[int(i)] for i in order]
        rankings_by_arm[arm] = rankings
        summarize(arm, rankings)

    # 多视角融合：引用视图 + 描述视图，验证「分开建索引再 RRF」是否优于拼接
    fusion_defs = {
        "E_B+C_rrf": (["B_caption_refs", "C_caption_desc"], [0.5, 0.5]),
        "F_A+B+C_rrf": (["A_caption", "B_caption_refs", "C_caption_desc"], [0.3, 0.35, 0.35]),
    }
    for arm, (parts, weights) in fusion_defs.items():
        fused_rankings: dict[str, list[str]] = {}
        for query in queries:
            qid = query["queryId"]
            fused_rankings[qid] = rrf_fuse(
                [rankings_by_arm[part][qid] for part in parts], weights
            )[:CANDIDATE_K]
        summarize(arm, fused_rankings)

    # 分数级融合：同一个 embedding 空间里直接加权/取 max，避免 RRF 丢掉分数信息
    chunk_n = len(chunk_keys)
    chunk_scores = scores_by_arm["A_caption"][:, :chunk_n]
    element_scores = {arm: scores_by_arm[arm][:, chunk_n:] for arm in ARMS}
    score_fusions = {
        "G_views_max": np.maximum.reduce(
            [element_scores["A_caption"], element_scores["B_caption_refs"], element_scores["C_caption_desc"]]
        ),
        "H_B+C_score": 0.5 * element_scores["B_caption_refs"] + 0.5 * element_scores["C_caption_desc"],
        "I_A+B+C_score": (
            0.3 * element_scores["A_caption"]
            + 0.35 * element_scores["B_caption_refs"]
            + 0.35 * element_scores["C_caption_desc"]
        ),
    }
    for arm, elem_score in score_fusions.items():
        full_scores = np.hstack([chunk_scores, elem_score])
        rankings = {}
        for index, query in enumerate(queries):
            order = np.argsort(-full_scores[index])[:CANDIDATE_K]
            rankings[query["queryId"]] = [ids[int(i)] for i in order]
        summarize(arm, rankings)

    write_report(elements, queries, results, details)
    (DATA_DIR / "figure_index_eval.json").write_text(
        json.dumps(
            {
                "elements": len(elements),
                "textbox": textbox,
                "noRefs": refs0,
                "queries": by_source,
                "results": results,
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )


def write_report(
    elements: list[dict],
    queries: list[dict],
    results: dict,
    details: list[dict],
) -> None:
    report_dir = EVAL_DIR / "reports"
    report_dir.mkdir(exist_ok=True)
    textbox = sum(1 for e in elements if e["isTextbox"])
    no_refs = sum(1 for e in elements if not e["references"])
    sources = [s for s in ("ref", "caption", "visual") if s in next(iter(results.values()), {})]
    lines = [
        "# 图表召回实验：图注 vs 正文引用 vs VLM 描述",
        "",
        "## 数据集",
        "",
        f"- 有裁剪图与 VLM 描述的元素：{len(elements)} 个",
        f"- 文字型图（instructions/excerpt/prompt 等）：{textbox} 个",
        f"- 正文中无引用句的图：{no_refs} 个",
        f"- 查询：{dict(Counter(q['source'] for q in queries))}",
        "",
        "## 结果（ElementRecall@5）",
        "",
        "| 实验臂 | " + " | ".join(SOURCE_LABEL[s] for s in sources) + " |",
        "|---|" + "---|" * len(sources),
    ]
    for arm in results:
        cells = []
        for source in sources:
            stat = results.get(arm, {}).get(source)
            cells.append(f"{stat['elementRecall@5']:.1%}" if stat else "-")
        lines.append(f"| {arm} | " + " | ".join(cells) + " |")

    lines += [
        "",
        "## 结果（CaptionChunkRecall@5，现有正文 chunk 的间接召回）",
        "",
        "| 实验臂 | " + " | ".join(SOURCE_LABEL[s] for s in sources) + " |",
        "|---|" + "---|" * len(sources),
    ]
    for arm in results:
        cells = []
        for source in sources:
            stat = results.get(arm, {}).get(source)
            cells.append(f"{stat['captionChunkRecall@5']:.1%}" if stat else "-")
        lines.append(f"| {arm} | " + " | ".join(cells) + " |")

    lines += ["", "## 样例", ""]
    # 看图查询：A 漏、D 中
    sample = [x for x in details if x["source"] == "visual" and x["arm"] == "A_caption" and x["elementRank"] == 0]
    for item in sample[:3]:
        d = next(
            (x for x in details if x["arm"] == "D_all" and x["queryId"] == item["queryId"]),
            None,
        )
        if not d:
            continue
        element = next(e for e in elements if e["elementId"] == item["elementId"])
        lines.append(
            f"- 「{item['query']}」\n"
            f"  - 图注：{element['caption'][:120]}\n"
            f"  - A 未召回 / D 排名：{d['elementRank'] or '未进 top5'}"
        )
    if len(lines) and lines[-1] == "":
        lines.pop()

    lines += [
        "",
        "## 口径与限制",
        "",
        "- 查询由模型从引用句/图注/图片生成，不是真实用户分布；",
        "- `visual` 查询由 qwen3-vl-plus 看图生成，和 C/D 的描述同源，存在一定偏置；",
        "- 语料是改造前的 1523 个 QA chunk 对应的 2181 个正文 chunk，不代表当前 v3 切分的绝对值；",
        "- 文字型图（InstructGPT 的 instructions 等）不参与看图查询，但仍参与引用/图注查询。",
    ]
    (report_dir / "figure_index_eval.md").write_text("\n".join(lines), encoding="utf-8")
    log(f"报告: {report_dir / 'figure_index_eval.md'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="图表召回实验")
    parser.add_argument("--rebuild-queries", action="store_true", help="重新生成查询")
    args = parser.parse_args()
    asyncio.run(main(args.rebuild_queries))
