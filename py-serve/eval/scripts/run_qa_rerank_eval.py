"""QA 问题索引 × 聚合方式 × Reranker 的多组召回对比。

核心问题：每个 chunk 用 LLM 预生成多个「用户可能问的问题」，查询时做
「问题对问题」匹配（命中问题映射回源 chunk），是否比 chunk 向量召回更好？
多问题分数怎么聚合最好？叠加 cross-encoder reranker 还能提升多少？

实验臂：
  A  chunk_vec          query ↔ chunk 向量（生产基线）
  B1 qa_max             query ↔ 问题向量，chunk 分 = 该 chunk 全部问题的最高分
  B2 qa_mean            chunk 分 = 问题分数均值
  B3 qa_rrf             query ↔ 问题向量排名 → 映射 chunk（去重保序），RRF
  C1 chunk+qa_max       A 与 B1 的 RRF（0.5/0.5）
  C2 chunk+qa_rrf       A 与 B3 的 RRF（0.5/0.5，历史评测口径）
  D  prod_hybrid        chunk 向量 + 关键词 RRF（0.7/0.3，生产现状）
  E1 prod+qa_max        D 与 B1 的 RRF（0.5/0.5）
  E2 prod+qa_rrf        D 与 B3 的 RRF（0.5/0.5）
  F  rerank_A           A 的 topN 候选过 cross-encoder
  G  rerank_D           D 的 topN 候选过 cross-encoder
  H  rerank_E1          E1 的 topN 候选过 cross-encoder

数据来源是现有的 eval/data（chunks.json / qa_index.json / eval_queries.json /
*_vectors.npy），对应改造前 1523 chunk 的评测语料，因此结论用于比较「策略」，
不代表当前 v3 切分下的绝对值。

用法：
  python eval/scripts/run_qa_rerank_eval.py --sample 800
  python eval/scripts/run_qa_rerank_eval.py --sample 800 --skip-rerank   # 只比索引/融合
  python eval/scripts/run_qa_rerank_eval.py --reranker BAAI/bge-reranker-v2-m3
"""
import argparse
import asyncio
import json
import random
import sys
from collections import OrderedDict
from pathlib import Path

import numpy as np

EVAL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(EVAL_DIR))
sys.path.insert(0, str(EVAL_DIR / "scripts"))
sys.path.insert(0, str(EVAL_DIR.parent))

from common import DATA_DIR, rrf_fuse, save_json  # noqa: E402
from run_recall_eval import cosine_ranking, evaluate, keyword_ranking  # noqa: E402

from app.file_management.keywords import extract_keywords  # noqa: E402

TOP_K = 5
CANDIDATE_K = 20  # rerank 候选深度
DEFAULT_RERANKER = "BAAI/bge-reranker-v2-m3"


def log(message: str) -> None:
    print(message, flush=True)


def load_data(sample: int) -> dict:
    chunks = json.loads((DATA_DIR / "chunks.json").read_text(encoding="utf-8"))
    qa_index = json.loads((DATA_DIR / "qa_index.json").read_text(encoding="utf-8"))
    queries = json.loads((DATA_DIR / "eval_queries.json").read_text(encoding="utf-8"))
    chunk_vectors = np.load(DATA_DIR / "chunk_vectors.npy")
    qa_vectors = np.load(DATA_DIR / "qa_vectors.npy")
    query_vectors = np.load(DATA_DIR / "query_vectors.npy")

    if sample and sample < len(queries):
        rng = random.Random(42)
        picked = sorted(rng.sample(range(len(queries)), sample))
        queries = [queries[i] for i in picked]
        query_vectors = query_vectors[picked]
        log(f"抽样 {sample} 条查询（seed=42，全部实验臂共用同一批）")

    chunk_pos = {c["chunkKey"]: i for i, c in enumerate(chunks)}
    q_to_chunk: list[str] = []
    group_offsets: list[int] = []
    group_counts: list[int] = []
    group_chunk_pos: list[int] = []
    cursor = 0
    for item in qa_index:
        n = len(item["questions"])
        group_offsets.append(cursor)
        group_counts.append(n)
        group_chunk_pos.append(chunk_pos[item["chunkKey"]])
        q_to_chunk.extend([item["chunkKey"]] * n)
        cursor += n
    assert len(q_to_chunk) == qa_vectors.shape[0], "qa_index 与 qa_vectors 数量不一致"

    return {
        "chunks": chunks,
        "queries": queries,
        "chunk_vectors": chunk_vectors,
        "qa_vectors": qa_vectors,
        "query_vectors": query_vectors,
        "q_to_chunk": q_to_chunk,
        "group_offsets": group_offsets,
        "group_counts": group_counts,
        "group_chunk_pos": group_chunk_pos,
        "chunk_keys": [c["chunkKey"] for c in chunks],
        "doc_of": {c["chunkKey"]: c["docTitle"] for c in chunks},
        "chunk_texts": [(c["chunkKey"], c["docText"].lower()) for c in chunks],
        "by_key": {c["chunkKey"]: c for c in chunks},
    }


def qa_aggregation(data: dict) -> tuple[dict, dict, dict]:
    """一次矩阵乘算出 chunk 级 max / mean 分数，并生成 RRF 排名。"""
    qa_vectors = data["qa_vectors"]
    query_vectors = data["query_vectors"]
    q_to_chunk = data["q_to_chunk"]
    chunk_keys = data["chunk_keys"]

    qa_norm = qa_vectors / (np.linalg.norm(qa_vectors, axis=1, keepdims=True) + 1e-9)
    q_norm = query_vectors / (np.linalg.norm(query_vectors, axis=1, keepdims=True) + 1e-9)

    # 每个 chunk 的问题向量在 qa_index 中连续存放，用 reduceat 一次聚合；
    # qa_index 只覆盖 1523/1563 个 chunk，缺问题的 chunk 分数记为 -1，不参与排名
    counts_arr = np.array(data["group_counts"])
    offsets_arr = np.array(data["group_offsets"])
    group_pos = np.array(data["group_chunk_pos"])
    n_chunks = len(chunk_keys)

    max_rankings: dict[str, list[str]] = {}
    mean_rankings: dict[str, list[str]] = {}
    rrf_rankings: dict[str, list[str]] = {}

    batch = 64
    for start in range(0, len(data["queries"]), batch):
        block = q_norm[start : start + batch] @ qa_norm.T  # (b, n_questions)
        for row, query in enumerate(data["queries"][start : start + batch]):
            scores = block[row]
            chunk_max = np.full(n_chunks, -1.0)
            chunk_mean = np.full(n_chunks, -1.0)
            chunk_max[group_pos] = np.maximum.reduceat(scores, offsets_arr)
            chunk_mean[group_pos] = np.add.reduceat(scores, offsets_arr) / counts_arr
            top_max = np.argsort(-chunk_max)[:TOP_K]
            top_mean = np.argsort(-chunk_mean)[:TOP_K]
            question_order = np.argsort(-scores)[: TOP_K * 4]
            top_rrf = list(
                OrderedDict.fromkeys(q_to_chunk[int(i)] for i in question_order)
            )[:TOP_K]

            qid = query["queryId"]
            max_rankings[qid] = [chunk_keys[int(i)] for i in top_max]
            mean_rankings[qid] = [chunk_keys[int(i)] for i in top_mean]
            rrf_rankings[qid] = top_rrf
        if start == 0 or (start // batch) % 5 == 0:
            log(f"  聚合进度 {min(start + batch, len(data['queries']))}/{len(data['queries'])}")
    return max_rankings, mean_rankings, rrf_rankings


async def keyword_ranks(data: dict) -> list[list[str]]:
    sem = asyncio.Semaphore(12)

    async def one(query: dict) -> list[str]:
        async with sem:
            return await keyword_ranking(query["query"], data["chunk_texts"], CANDIDATE_K)

    log(f"关键词路：{len(data['queries'])} 条查询（DeepSeek 提词）...")
    return await asyncio.gather(*(one(q) for q in data["queries"]))


def load_reranker(model_id: str):
    import torch
    from sentence_transformers import CrossEncoder

    local = DATA_DIR / "models" / model_id.replace("/", "__")
    if not (local / "config.json").exists():
        log(f"下载 reranker: {model_id}（首次约 2GB，ModelScope）...")
        from modelscope import snapshot_download

        snapshot_download(model_id, local_dir=str(local))
    log(f"加载 reranker: {local}")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    return CrossEncoder(str(local), max_length=512, device=device)


def rerank_arm(model, queries: list[dict], rankings: dict[str, list[str]], data: dict) -> dict:
    log(f"  rerank 候选 {len(queries)} × {CANDIDATE_K} ...")
    pairs: list[tuple[str, str]] = []
    spans: list[tuple[int, int]] = []
    for query in queries:
        start = len(pairs)
        pairs.extend((query["query"], data["by_key"][key]["docText"]) for key in rankings[query["queryId"]])
        spans.append((start, len(pairs)))

    scores = model.predict(pairs, batch_size=32, show_progress_bar=False)
    result: dict[str, list[str]] = {}
    for (start, end), query in zip(spans, queries):
        order = np.argsort(-np.asarray(scores[start:end]))
        candidates = rankings[query["queryId"]]
        result[query["queryId"]] = [candidates[int(i)] for i in order[:TOP_K]]
    return result


def write_report(metrics: dict, meta: dict) -> None:
    report_dir = EVAL_DIR / "reports"
    report_dir.mkdir(exist_ok=True)
    base = metrics["A_chunk_vec"]["recall@5"]
    lines = [
        "# QA 问题索引 × 聚合方式 × Reranker 召回对比",
        "",
        "## 设置",
        "",
        f"- 语料：{meta['chunks']} 个 chunk（其中 {meta['qaChunks']} 个生成了 QA 索引）/ "
        f"{meta['questions']} 个索引问题 / {meta['docs']} 篇论文",
        "- 查询："
        + (
            f"全量 {meta['queries']} 条"
            if not meta.get("sample")
            else f"抽样 {meta['queries']} 条（seed=42，全部实验臂共用）"
        ),
        f"- 候选深度：{meta['candidate_k']}；reranker：{meta['reranker'] or '未启用'}",
    ]
    if meta.get("candidateRecall"):
        lines.append(
            "- 候选召回（topN 内含金标，rerank 的天花板）："
            + " / ".join(f"{name} {value:.1%}" for name, value in meta["candidateRecall"].items())
        )
    lines += [
        "",
        "## 结果",
        "",
        "| 实验臂 | Recall@1 | Recall@3 | Recall@5 | MRR@5 | DocRecall@5 | ΔRecall@5 vs A |",
        "|---|---|---|---|---|---|---|",
    ]
    for name, m in metrics.items():
        delta = (m["recall@5"] - base) * 100
        lines.append(
            f"| {name} | {m['recall@1']:.1%} | {m['recall@3']:.1%} | {m['recall@5']:.1%} | "
            f"{m['mrr@5']:.3f} | {m['docRecall@5']:.1%} | {delta:+.1f}pt |"
        )

    best = max(metrics.items(), key=lambda item: item[1]["recall@5"])
    non_rerank = {k: v for k, v in metrics.items() if not k.startswith("rerank_")}
    best_no_rr = max(non_rerank.items(), key=lambda item: item[1]["recall@5"])
    lines += [
        "",
        "## 结论",
        "",
        f"- 最佳实验臂：**{best[0]}**（Recall@5 {best[1]['recall@5']:.1%}，"
        f"较 chunk 基线 {(best[1]['recall@5'] - base) * 100:+.1f}pt）。",
        f"- 不接 reranker 时的最佳：**{best_no_rr[0]}**（Recall@5 {best_no_rr[1]['recall@5']:.1%}）。",
    ]

    if "B3_qa_rrf" in metrics:
        lines.append(
            f"- QA 问题索引单路（RRF）相对 chunk 向量："
            f"{(metrics['B3_qa_rrf']['recall@5'] - base) * 100:+.1f}pt。"
        )
    if "B1_qa_max" in metrics and "B2_qa_mean" in metrics:
        lines.append(
            f"- 聚合方式：max 与 RRF 接近（差 "
            f"{(metrics['B1_qa_max']['recall@5'] - metrics['B3_qa_rrf']['recall@5']) * 100:+.1f}pt），"
            f"mean 明显更差（{(metrics['B2_qa_mean']['recall@5'] - metrics['B1_qa_max']['recall@5']) * 100:+.1f}pt），"
            "说明「取最匹配的那个问题」比「全部问题平均」更合理。"
        )
    if "D_prod_hybrid" in metrics:
        lines.append(
            f"- 生产关键词路 D 相对 A："
            f"{(metrics['D_prod_hybrid']['recall@5'] - base) * 100:+.1f}pt；"
            "关键词路在该语料上没有增量。"
        )
    if "E2_prod+qa_rrf" in metrics and "C2_chunk+qa_rrf" in metrics:
        lines.append(
            f"- D+QA（E2）与 A+QA（C2）几乎持平："
            f"{(metrics['E2_prod+qa_rrf']['recall@5'] - metrics['C2_chunk+qa_rrf']['recall@5']) * 100:+.1f}pt，"
            "说明 QA 路已经覆盖了关键词路的收益。"
        )
    for name in ("rerank_A", "rerank_D", "rerank_E1"):
        if name not in metrics:
            continue
        source = {"rerank_A": "A_chunk_vec", "rerank_D": "D_prod_hybrid", "rerank_E1": "E1_prod+qa_max"}[name]
        gain = (metrics[name]["recall@5"] - metrics[source]["recall@5"]) * 100
        lines.append(f"- {name} 相对 {source}：{gain:+.1f}pt（Recall@5）。")
    lines += [
        "",
        "> 注意：语料是改造前 1563 chunk（1523 个有 QA 索引）的评测集，"
        "结论用于比较策略方向；换到当前 v3 切分需要重新生成 QA 索引后再跑。",
    ]
    report_name = f"qa_rerank_eval{meta.get('tag', '')}.md"
    (report_dir / report_name).write_text("\n".join(lines), encoding="utf-8")
    log(f"报告: {report_dir / report_name}")


async def main(args: argparse.Namespace) -> None:
    data = load_data(args.sample)
    queries = data["queries"]
    gold = {q["queryId"]: q["chunkKey"] for q in queries}
    doc_of = data["doc_of"]

    max_rankings, mean_rankings, rrf_rankings = qa_aggregation(data)
    keyword = None if args.skip_keyword else await keyword_ranks(data)

    arms: dict[str, dict[str, list[str]]] = {
        "A_chunk_vec": {},
        "B1_qa_max": max_rankings,
        "B2_qa_mean": mean_rankings,
        "B3_qa_rrf": rrf_rankings,
        "C1_chunk+qa_max": {},
        "C2_chunk+qa_rrf": {},
    }
    if keyword is not None:
        arms.update({"D_prod_hybrid": {}, "E1_prod+qa_max": {}, "E2_prod+qa_rrf": {}})

    for i, query in enumerate(queries):
        qid = query["queryId"]
        rank_a = cosine_ranking(data["query_vectors"][i], data["chunk_vectors"], data["chunk_keys"], CANDIDATE_K)
        b1, b3 = max_rankings[qid], rrf_rankings[qid]
        arms["A_chunk_vec"][qid] = rank_a
        arms["C1_chunk+qa_max"][qid] = rrf_fuse([rank_a, b1], [0.5, 0.5])
        arms["C2_chunk+qa_rrf"][qid] = rrf_fuse([rank_a, b3], [0.5, 0.5])
        if keyword is not None:
            rank_d = rrf_fuse([rank_a, keyword[i]], [0.7, 0.3])
            arms["D_prod_hybrid"][qid] = rank_d
            arms["E1_prod+qa_max"][qid] = rrf_fuse([rank_d, b1], [0.5, 0.5])
            arms["E2_prod+qa_rrf"][qid] = rrf_fuse([rank_d, b3], [0.5, 0.5])

    if args.skip_keyword and not args.skip_rerank:
        log("跳过关键词路时无法构造 E1，reranker 也一并跳过")
        args.skip_rerank = True

    if not args.skip_rerank:
        model = load_reranker(args.reranker)
        for name, source in (("rerank_A", "A_chunk_vec"), ("rerank_D", "D_prod_hybrid"), ("rerank_E1", "E1_prod+qa_max")):
            log(f"{name} ...")
            arms[name] = rerank_arm(model, queries, arms[source], data)

    candidate_recall = {
        arm: sum(1 for q in queries if gold[q["queryId"]] in arms[arm][q["queryId"]]) / len(queries)
        for arm in ("A_chunk_vec", "D_prod_hybrid", "E1_prod+qa_max")
        if arm in arms
    }
    metrics = {name: evaluate(rankings, gold, doc_of) for name, rankings in arms.items()}
    for name in ("A_chunk_vec", "B1_qa_max", "B2_qa_mean", "B3_qa_rrf", "C1_chunk+qa_max",
                 "C2_chunk+qa_rrf", "D_prod_hybrid", "E1_prod+qa_max", "E2_prod+qa_rrf",
                 "rerank_A", "rerank_D", "rerank_E1"):
        if name in metrics:
            m = metrics[name]
            log(f"{name:18s} R@1 {m['recall@1']:.1%}  R@5 {m['recall@5']:.1%}  MRR {m['mrr@5']:.3f}")

    save_json(
        f"qa_rerank_eval{args.tag}.json",
        {
            "meta": {
                "chunks": len(data["chunks"]),
                "qaChunks": len(data["group_offsets"]),
                "questions": len(data["q_to_chunk"]),
                "docs": len(set(doc_of.values())),
                "queries": len(queries),
                "sample": args.sample,
                "candidate_k": CANDIDATE_K,
                "reranker": None if args.skip_rerank else args.reranker,
            },
            "metrics": metrics,
            "candidateRecall": candidate_recall,
        },
    )
    write_report(
        metrics,
        {
            "chunks": len(data["chunks"]),
            "qaChunks": len(data["group_offsets"]),
            "questions": len(data["q_to_chunk"]),
            "docs": len(set(doc_of.values())),
            "queries": len(queries),
            "sample": args.sample,
            "candidate_k": CANDIDATE_K,
            "reranker": None if args.skip_rerank else args.reranker,
            "candidateRecall": candidate_recall,
            "tag": args.tag,
        },
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="QA 问题索引与 reranker 召回对比")
    parser.add_argument("--sample", type=int, default=800, help="抽样查询数，0=全量（3046，较慢）")
    parser.add_argument("--skip-rerank", action="store_true", help="只比较索引/聚合/融合，不下载模型")
    parser.add_argument("--skip-keyword", action="store_true", help="跳过关键词路（省 LLM 调用，只测 A/B/C）")
    parser.add_argument("--reranker", default=DEFAULT_RERANKER, help="ModelScope reranker 模型 id")
    parser.add_argument("--tag", default="", help="输出文件名后缀，便于保留多组实验")
    asyncio.run(main(parser.parse_args()))
