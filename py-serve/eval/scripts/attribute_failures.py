"""检索失败归因实验：区分「排序没排上来」和「库里根本没有」。

背景：召回率只能说明「金标 chunk 有没有进 top-k」，但无法回答：
  - 失败是排序问题（内容在库，只是没排进 top5）？
  - 还是覆盖问题（答案在表格/图片/公式里，文本索引里根本不存在）？

做法：
  1. 用当前生产的解析 + 结构感知切分重新构建语料（默认 docs/ 下全部论文，
     排除试卷类 PDF 和过大的 RLbook）；
  2. 生成两类查询：
     - text：从正文 chunk 生成用户风格问题，金标=源 chunk；
     - caption：从 Table/Figure 标题附近生成必须依赖图表内容的问题，金标=图注所在 chunk；
  3. 用生产同款混合检索（向量 + 关键词 RRF 0.7/0.3）取 top5；
  4. 对失败样本调用 LLM 做归因：答案是否在检索片段里、是否在金标片段里、
     缺失内容属于正文/表格/图片/公式；
  5. 输出 JSON + Markdown 报告，给出「先补覆盖还是先做 rerank」的数据结论。

用法：
  python eval/scripts/attribute_failures.py            # 首次会构建语料并向量化
  python eval/scripts/attribute_failures.py --rebuild  # 重新解析论文、重新生成查询
"""
import argparse
import asyncio
import bisect
import hashlib
import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

EVAL_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = EVAL_DIR.parent.parent
sys.path.insert(0, str(EVAL_DIR))
sys.path.insert(0, str(EVAL_DIR / "scripts"))
sys.path.insert(0, str(EVAL_DIR.parent))

from common import DATA_DIR, ds_chat, embed_texts, load_json, parse_json_object, rrf_fuse, save_json  # noqa: E402
from run_recall_eval import cosine_ranking, keyword_ranking  # noqa: E402

from app.core.config import Config  # noqa: E402
from app.file_management.parsers import parse_file_with_pages  # noqa: E402
from app.file_management.structure import split_document_with_sections  # noqa: E402

DOCS_DIR = REPO_DIR / "docs"
REPORT_DIR = EVAL_DIR / "reports"
CORPUS_PATH = DATA_DIR / "attr_corpus.json"
CHUNK_VECTOR_PATH = DATA_DIR / "attr_chunk_vectors.npy"
QUERY_PATH = DATA_DIR / "attr_queries.json"
QUERY_VECTOR_PATH = DATA_DIR / "attr_query_vectors.npy"
RESULT_PATH = DATA_DIR / "failure_attribution.json"

EXCLUDE_DOCS = ("面试题", "RLbook2020")  # 试卷类 & 500+ 页教材，避免语料失衡
TEXT_CHUNKS_PER_DOC = 5
CAPTIONS_PER_DOC = 4  # 每篇最多 2 表 + 2 图，扩大图表样本
TOP_K = 5
CANDIDATE_K = 10
SEED = 42
CONCURRENCY = 8
MAX_JUDGE_CHARS = 700
MAX_GOLD_CHARS = 900

TEXT_QUERY_PROMPT = """你负责为科研问答系统构造「真实用户测试问题」。给定一个文档片段，站在用户角度写 2 个他可能会向 AI 科研助手提出的口语化问题。
要求：
1. 语气自然随意，像真人打字，可以用同义词、简称、缩写或模糊表述；
2. 禁止照抄片段中的原句措辞，必须换一种说法；
3. 问题答案应当主要来自这个片段；
4. 两个问题要问片段的不同侧面；
5. 只输出 JSON：{"queries": ["问题1", "问题2"]}"""

CAPTION_QUERY_PROMPT = """你在模拟科研助手用户的真实提问。下面是一篇论文中某个图表的标题及紧随其后的内容（可能包含表格数据或图注）。
请写 1 个用户可能提出的、必须依赖该图表的具体内容才能回答的问题。
要求：
1. 问具体数值、对比结果、结构细节或实验设置，不要问标题里已经写明的结论；
2. 口语化、自然，不要照抄原文措辞；
3. 只输出 JSON：{"query": "..."}"""

JUDGE_PROMPT = """你是检索失败归因分析员。给定用户问题、检索到的片段（最多 5 个）和金标片段（问题生成时的来源，可能是图注或表格附近的文本）。
请判断并只输出 JSON：
{
 "answerable_from_retrieved": true/false,
 "answerable_from_gold": true/false,
 "missing": "none|text|table|figure|formula|other",
 "reason": "一句话说明"
}
判断标准：
- 只有片段中明确给出回答问题所需的事实、数值或结构时才算 true，需要推测或外部知识算 false；
- missing 表示若不能回答，最可能缺失的内容类型：table=表格中的数值/行列数据，figure=图片或示意图中的结构信息，formula=公式，text=正文其他段落，other=其他或无法判断。"""

CAPTION_RE = re.compile(r"(?im)^\s*(table|figure|fig\.)\s*\d+[\.:]")


def log(message: str) -> None:
    print(message, flush=True)


def stable_doc_id(title: str) -> str:
    return hashlib.md5(title.encode("utf-8")).hexdigest()[:16]


def build_corpus() -> dict:
    """解析论文并切分，产出 docs（含全文，供图表标题定位）与 chunks。"""
    pdfs = [
        p for p in sorted(DOCS_DIR.glob("*.pdf"))
        if not any(pattern in p.name for pattern in EXCLUDE_DOCS)
    ]
    if not pdfs:
        raise SystemExit(f"docs 目录没有可用 PDF: {DOCS_DIR}")

    log(f"解析 {len(pdfs)} 篇论文（排除 {', '.join(EXCLUDE_DOCS)}）...")
    docs: list[dict] = []
    chunks: list[dict] = []
    for pdf in pdfs:
        text, page_starts = parse_file_with_pages(pdf.read_bytes(), "pdf")
        spans, sections = split_document_with_sections(text, page_starts)
        if not spans:
            log(f"  跳过（无有效文本）: {pdf.name}")
            continue
        title = pdf.stem
        doc_id = stable_doc_id(title)
        docs.append(
            {"docId": doc_id, "title": title, "text": text, "pages": len(page_starts)}
        )
        chunks.extend(
            {
                "chunkKey": f"{doc_id}#{span.chunk_index}",
                "docId": doc_id,
                "docTitle": title,
                "text": span.text,
                "section": span.section,
                "page": span.page,
                "charStart": span.char_start,
                "charEnd": span.char_end,
            }
            for span in spans
        )
        log(f"  {title[:48]:50s} chunks={len(spans):4d} sections={len(sections):3d}")

    log(f"语料：{len(docs)} 篇论文，{len(chunks)} 个 chunk")
    return {"docs": docs, "chunks": chunks}


def ensure_corpus(rebuild: bool) -> dict:
    if CORPUS_PATH.exists() and not rebuild:
        corpus = load_json("attr_corpus.json")
        log(f"载入缓存语料：{len(corpus['docs'])} 篇 / {len(corpus['chunks'])} chunks")
        return corpus
    corpus = build_corpus()
    save_json("attr_corpus.json", corpus)
    return corpus


async def ensure_chunk_vectors(corpus: dict) -> np.ndarray:
    chunks = corpus["chunks"]
    if CHUNK_VECTOR_PATH.exists():
        vectors = np.load(CHUNK_VECTOR_PATH)
        if vectors.shape[0] == len(chunks):
            return vectors
    log(f"向量化 {len(chunks)} 个 chunk（首次运行约 1~3 分钟）...")
    vectors = await embed_texts([c["text"] for c in chunks])
    np.save(CHUNK_VECTOR_PATH, vectors)
    log(f"chunk 向量: {vectors.shape}")
    return vectors


def _chunks_by_doc(corpus: dict) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for chunk in corpus["chunks"]:
        grouped[chunk["docId"]].append(chunk)
    for items in grouped.values():
        items.sort(key=lambda x: x["charStart"])
    return grouped


def _chunk_at(chunks: list[dict], offset: int) -> dict | None:
    starts = [c["charStart"] for c in chunks]
    index = bisect.bisect_right(starts, offset) - 1
    if index < 0:
        return None
    chunk = chunks[index]
    return chunk if offset < chunk["charEnd"] else None


def caption_targets(corpus: dict) -> list[dict]:
    """为每篇论文挑 1 个表格标题 + 1 个图片标题，映射到其所在 chunk。"""
    grouped = _chunks_by_doc(corpus)
    targets: list[dict] = []
    for doc in corpus["docs"]:
        matches = list(CAPTION_RE.finditer(doc["text"]))
        if not matches:
            continue
        tables = [m for m in matches if m.group(1).lower() == "table"]
        figures = [m for m in matches if m.group(1).lower() != "table"]
        preferred = tables[:2] + figures[:2]
        if len(preferred) < CAPTIONS_PER_DOC:
            preferred += [m for m in matches if m not in preferred][: CAPTIONS_PER_DOC - len(preferred)]

        seen: set[str] = set()
        for match in preferred:
            chunk = _chunk_at(grouped[doc["docId"]], match.start())
            if chunk is None or chunk["chunkKey"] in seen:
                continue
            seen.add(chunk["chunkKey"])
            targets.append(
                {
                    "docTitle": doc["title"],
                    "docId": doc["docId"],
                    "chunkKey": chunk["chunkKey"],
                    "caption": doc["text"][match.start(): match.start() + 1200],
                    "captionOffset": match.start(),
                }
            )
    return targets


async def gen_text_queries(corpus: dict, sem: asyncio.Semaphore) -> list[dict]:
    rng = random.Random(SEED)
    grouped = _chunks_by_doc(corpus)
    sampled: list[dict] = []
    skip_sections = ("references", "参考文献", "acknowledg", "appendix", "附录")
    for doc in corpus["docs"]:
        candidates = [
            c for c in grouped[doc["docId"]]
            if len(c["text"]) >= 250
            and not c["text"].lstrip().startswith(("Table ", "Figure "))
            # 参考文献/致谢/附录里生成的“问题”大多不是正文诉求，会污染归因
            and not any(bad in (c["section"] or "").lower() for bad in skip_sections)
        ]
        if not candidates:
            continue
        sampled.extend(rng.sample(candidates, min(TEXT_CHUNKS_PER_DOC, len(candidates))))

    async def one(chunk: dict) -> list[dict]:
        user = f"【文档：{chunk['docTitle']}】\n片段内容：\n{chunk['text']}"
        try:
            raw = await ds_chat(Config.DEEPSEEK_MODEL, TEXT_QUERY_PROMPT, user, 0.9, sem)
            queries = parse_json_object(raw).get("queries", [])
        except Exception as exc:
            log(f"  正文查询生成失败（{chunk['chunkKey']}）: {exc}")
            return []
        return [
            {
                "queryId": f"{chunk['chunkKey']}::text{i}",
                "source": "text",
                "query": q.strip(),
                "chunkKey": chunk["chunkKey"],
                "docTitle": chunk["docTitle"],
            }
            for i, q in enumerate(queries)
            if isinstance(q, str) and q.strip()
        ]

    log(f"生成正文查询：{len(sampled)} 个 chunk × 2 ...")
    groups = await asyncio.gather(*(one(c) for c in sampled))
    return [q for group in groups for q in group]


async def gen_caption_queries(corpus: dict, sem: asyncio.Semaphore) -> list[dict]:
    targets = caption_targets(corpus)
    log(f"生成图表查询：{len(targets)} 个图表标题 ...")

    async def one(target: dict) -> list[dict]:
        user = f"【文档：{target['docTitle']}】\n【图表标题及附近内容】\n{target['caption']}"
        try:
            raw = await ds_chat(Config.DEEPSEEK_MODEL, CAPTION_QUERY_PROMPT, user, 0.7, sem)
            query = parse_json_object(raw).get("query", "")
        except Exception as exc:
            log(f"  图表查询生成失败（{target['chunkKey']}）: {exc}")
            return []
        if not isinstance(query, str) or not query.strip():
            return []
        return [
            {
                "queryId": f"{target['chunkKey']}::cap",
                "source": "caption",
                "query": query.strip(),
                "chunkKey": target["chunkKey"],
                "docTitle": target["docTitle"],
                "caption": target["caption"][:300],
            }
        ]

    groups = await asyncio.gather(*(one(t) for t in targets))
    return [q for group in groups for q in group]


async def ensure_queries(corpus: dict, rebuild: bool) -> list[dict]:
    if QUERY_PATH.exists() and not rebuild:
        queries = load_json("attr_queries.json")
        valid = {c["chunkKey"] for c in corpus["chunks"]}
        kept = [q for q in queries if q["chunkKey"] in valid]
        if len(kept) != len(queries):
            log(f"缓存查询有 {len(queries) - len(kept)} 条金标已不存在，已丢弃（可加 --rebuild 重新生成）")
        log(f"载入缓存查询：{len(kept)} 条")
        return kept
    sem = asyncio.Semaphore(CONCURRENCY)
    text_queries = await gen_text_queries(corpus, sem)
    caption_queries = await gen_caption_queries(corpus, sem)
    queries = text_queries + caption_queries
    save_json("attr_queries.json", queries)
    log(f"查询总数 {len(queries)}（正文 {len(text_queries)} / 图表 {len(caption_queries)}）")
    return queries


async def ensure_query_vectors(queries: list[dict]) -> np.ndarray:
    if QUERY_VECTOR_PATH.exists():
        vectors = np.load(QUERY_VECTOR_PATH)
        if vectors.shape[0] == len(queries):
            return vectors
    log(f"向量化 {len(queries)} 条查询 ...")
    vectors = await embed_texts([q["query"] for q in queries])
    np.save(QUERY_VECTOR_PATH, vectors)
    return vectors


async def judge(
    query: str,
    retrieved: list[dict],
    gold: dict,
    sem: asyncio.Semaphore,
) -> dict:
    context = "\n\n".join(
        f"【检索片段{i}】\n{chunk['text'][:MAX_JUDGE_CHARS]}"
        for i, chunk in enumerate(retrieved, 1)
    )
    user = (
        f"用户问题：{query}\n\n"
        f"检索到的片段：\n{context}\n\n"
        f"金标片段：\n{gold['text'][:MAX_GOLD_CHARS]}"
    )
    try:
        raw = await ds_chat(Config.DEEPSEEK_MODEL, JUDGE_PROMPT, user, 0, sem)
        data = parse_json_object(raw)
    except Exception as exc:  # 单条归因失败不影响整体报告
        return {"error": str(exc)[:200]}
    return {
        "answerable_from_retrieved": bool(data.get("answerable_from_retrieved")),
        "answerable_from_gold": bool(data.get("answerable_from_gold")),
        "missing": str(data.get("missing") or "other").lower(),
        "reason": str(data.get("reason") or "")[:300],
    }


def classify(query: dict, rank: int, verdict: dict | None) -> str:
    if verdict is None:
        return "success"
    if verdict.get("error"):
        return "error"
    if verdict.get("answerable_from_retrieved"):
        return "recovered"  # 其他片段能答，用户视角不算失败
    if verdict.get("answerable_from_gold"):
        return "ranking_miss"  # 金标在库，只是没排进 top5
    missing = verdict.get("missing", "other")
    if missing in {"table", "figure", "formula", "text"}:
        return f"coverage_{missing}"
    return "coverage_other"


async def main(rebuild: bool) -> None:
    corpus = ensure_corpus(rebuild)
    chunk_vectors = await ensure_chunk_vectors(corpus)
    queries = await ensure_queries(corpus, rebuild)
    query_vectors = await ensure_query_vectors(queries)

    chunks = corpus["chunks"]
    chunk_keys = [c["chunkKey"] for c in chunks]
    by_key = {c["chunkKey"]: c for c in chunks}
    chunk_texts = [(c["chunkKey"], c["text"].lower()) for c in chunks]

    log("混合检索（向量 + 关键词 RRF）...")
    kw_sem = asyncio.Semaphore(CONCURRENCY)

    async def retrieve(index: int, query: dict) -> dict:
        vector_rank = cosine_ranking(query_vectors[index], chunk_vectors, chunk_keys, CANDIDATE_K)
        async with kw_sem:
            keyword_rank = await keyword_ranking(query["query"], chunk_texts, CANDIDATE_K)
        fused = rrf_fuse([vector_rank, keyword_rank], [0.7, 0.3])[:TOP_K]
        gold = by_key[query["chunkKey"]]
        rank = fused.index(gold["chunkKey"]) + 1 if gold["chunkKey"] in fused else 0
        return {
            "queryId": query["queryId"],
            "source": query["source"],
            "query": query["query"],
            "docTitle": query["docTitle"],
            "chunkKey": gold["chunkKey"],
            "section": gold["section"],
            "goldRank": rank,
            "retrieved": [by_key[key] for key in fused],
        }

    results = await asyncio.gather(*(retrieve(i, q) for i, q in enumerate(queries)))

    log("失败归因（LLM 判断答案是否在片段里）...")
    judge_sem = asyncio.Semaphore(CONCURRENCY)

    async def attribute(item: dict) -> dict:
        gold = by_key[item["chunkKey"]]
        # 正文查询命中金标就算成功；图表查询必须判断「表格/图片内容是否真的可答」
        need_judge = item["goldRank"] == 0 or item["source"] == "caption"
        verdict = (
            await judge(item["query"], item["retrieved"], gold, judge_sem)
            if need_judge
            else None
        )
        return {**item, "verdict": verdict, "class": classify(item, item["goldRank"], verdict)}

    attributed = await asyncio.gather(*(attribute(item) for item in results))

    # ---------------- 汇总 ----------------
    summary: dict = {"corpus": {"docs": len(corpus["docs"]), "chunks": len(chunks)}, "bySource": {}}
    for source in ("text", "caption"):
        items = [x for x in attributed if x["source"] == source]
        if not items:
            continue
        n = len(items)
        hit1 = sum(1 for x in items if x["goldRank"] == 1)
        hit5 = sum(1 for x in items if 0 < x["goldRank"] <= 5)
        rr = sum(1.0 / x["goldRank"] for x in items if x["goldRank"] > 0)
        classes = Counter(x["class"] for x in items)
        summary["bySource"][source] = {
            "n": n,
            "recall@1": round(hit1 / n, 4),
            "recall@5": round(hit5 / n, 4),
            "mrr": round(rr / n, 4),
            "classes": dict(classes),
        }

    coverage = [x for x in attributed if x["class"].startswith("coverage_")]
    ranking = [x for x in attributed if x["class"] == "ranking_miss"]
    summary["coverageGap"] = {
        "total": len(coverage),
        "byType": dict(Counter(x["class"].removeprefix("coverage_") for x in coverage)),
    }
    summary["rankingMiss"] = len(ranking)

    failed = [x for x in attributed if x["class"] not in {"success", "recovered"}]
    summary["failed"] = len(failed)
    summary["judgeErrors"] = sum(1 for x in attributed if x["class"] == "error")

    RESULT_PATH.write_text(
        json.dumps({"summary": summary, "items": attributed}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    write_report(summary, attributed)
    log(f"原始结果: {RESULT_PATH}")
    log(f"报告: {REPORT_DIR / 'failure_attribution.md'}")


def write_report(summary: dict, items: list[dict]) -> None:
    REPORT_DIR.mkdir(exist_ok=True)
    text_stats = summary["bySource"].get("text", {})
    cap_stats = summary["bySource"].get("caption", {})
    gap = summary["coverageGap"]
    gap_total = gap["total"]
    gap_types = "、".join(f"{k} {v}" for k, v in sorted(gap["byType"].items())) or "无"

    lines = [
        "# 检索失败归因实验报告",
        "",
        "## 设置",
        "",
        f"- 语料：{summary['corpus']['docs']} 篇论文，{summary['corpus']['chunks']} 个 chunk（当前生产切分）",
        "- 检索：向量 + 关键词 RRF（0.7/0.3，k=60），候选 10，取 top5",
        "- 查询：正文 chunk 生成 2 条/块；图表标题生成 1 条/个",
        "",
        "## 召回",
        "",
        "| 查询类型 | 数量 | Recall@1 | Recall@5 | MRR | 可答率（success+recovered） |",
        "|---|---|---|---|---|---|",
    ]
    for label, stats in (("正文查询", text_stats), ("图表查询", cap_stats)):
        if stats:
            classes = stats.get("classes", {})
            answerable = (classes.get("success", 0) + classes.get("recovered", 0)) / stats["n"]
            lines.append(
                f"| {label} | {stats['n']} | {stats['recall@1']:.1%} | "
                f"{stats['recall@5']:.1%} | {stats['mrr']:.3f} | {answerable:.1%} |"
            )

    lines += [
        "",
        "## 失败归因",
        "",
        "| 类型 | 数量 | 说明 |",
        "|---|---|---|",
        f"| ranking_miss | {summary['rankingMiss']} | 金标在库，但没进 top5 |",
        f"| coverage_* | {gap_total} | 索引里没有回答问题所需内容（{gap_types}） |",
        f"| 失败合计 | {summary['failed']} | 不含 success / recovered |",
        f"| 归因失败 | {summary['judgeErrors']} | LLM 调用或解析异常 |",
        "",
        "## 判定",
        "",
    ]

    ranking_share = summary["rankingMiss"] / max(summary["failed"], 1)
    coverage_share = gap_total / max(summary["failed"], 1)
    if coverage_share >= 0.6:
        lines.append(
            f"覆盖缺口占失败的 {coverage_share:.0%}（排序问题 {ranking_share:.0%}）："
            "优先补图表/公式抽取，再谈 rerank。"
        )
    elif coverage_share >= 0.4:
        lines.append(
            f"覆盖缺口 {coverage_share:.0%}、排序问题 {ranking_share:.0%}，两者接近："
            "建议先做成本最低的图注/图片覆盖（覆盖缺口集中在 figure），同时补 BM25/rerank，"
            "不建议只做其中一项。"
        )
    else:
        lines.append(
            f"排序问题占失败的 {ranking_share:.0%}（覆盖缺口 {coverage_share:.0%}）："
            "当前更值得先做 BM25/稀疏向量 + rerank，图表抽取可后置。"
        )

    cap_classes = cap_stats.get("classes", {}) if cap_stats else {}
    cap_recovered = cap_classes.get("recovered", 0)
    if cap_stats:
        top_gap = max(gap["byType"].items(), key=lambda item: item[1]) if gap["byType"] else ("figure", 0)
        lines += [
            "",
            "说明：pypdf 会把表格数值抽成纯文本，部分“表格问题”仍能由检索到的文本片段回答"
            f"（图表查询中 {cap_recovered}/{cap_stats['n']} 条属于这种情况，可能是图注所在 chunk 本身，"
            "也可能是相邻正文），所以表格的结构化收益主要在准确率与可读性，而不是“从无到有”。"
            f"本次覆盖缺口最集中的是 {top_gap[0]}（{top_gap[1]} 条），它才是必须靠版面/视觉解析才能补的部分。",
        ]

    lines += ["", "## 样例", ""]
    for cls in ("ranking_miss", "coverage_table", "coverage_figure", "coverage_formula", "coverage_text"):
        samples = [x for x in items if x["class"] == cls][:3]
        if not samples:
            continue
        lines.append(f"### {cls}")
        for item in samples:
            reason = (item.get("verdict") or {}).get("reason", "")
            lines.append(
                f"- 「{item['query']}」\n"
                f"  - 文档：{item['docTitle']}｜章节：{item['section']}｜金标排名：{item['goldRank'] or '未进 top5'}\n"
                f"  - 归因：{reason}"
            )
        lines.append("")

    (REPORT_DIR / "failure_attribution.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="检索失败归因：排序问题 vs 覆盖问题")
    parser.add_argument("--rebuild", action="store_true", help="重新解析论文并重建查询（默认用缓存）")
    args = parser.parse_args()
    asyncio.run(main(args.rebuild))
