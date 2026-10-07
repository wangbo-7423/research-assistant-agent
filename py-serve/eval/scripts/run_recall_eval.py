"""召回对比实验：chunk 向量直接检索 vs QA 问题检索（大段→多问题，命中问题召回其 chunk）vs 融合。

金标构造：每条评测查询由其源 chunk 生成，金标 = 源 chunk（单一金标）。
指标：Recall@{1,3,5}（等价于 HitRate@k，单金标）、MRR@5。

检索臂（同一查询集、同一 chunk 集，仅匹配单元不同）：
  A chunk_vec     生产向量路：query ↔ chunk 向量
  B qa            QA 路：query ↔ 索引问题向量，命中问题映射回源 chunk（去重保序）
  C chunk+qa      A 与 B 的 RRF 融合（0.5/0.5, k=60）
  D prod_hybrid   生产现状：chunk 向量路 + 关键词路（DeepSeek 提词 + 词面匹配）RRF（0.7/0.3, k=60）
  E prod+qa       D 与 B 的 RRF 融合（0.5/0.5）

用法: python eval/scripts/run_recall_eval.py
"""
import asyncio
import json
import sys
from collections import OrderedDict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from common import DATA_DIR, load_json, rrf_fuse, save_json  # noqa: E402

from app.fileanagement.keywords import extract_keywords  # noqa: E402

TOP_K = 10  # 评测截断深度（生产实际取 5，报告同时给 @1/@3/@5）


def cosine_ranking(query_vec: np.ndarray, matrix: np.ndarray, ids: list[str], top_k: int) -> list[str]:
    q = query_vec / (np.linalg.norm(query_vec) + 1e-9)
    m = matrix / (np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-9)
    scores = m @ q
    order = np.argsort(-scores)[:top_k]
    return [ids[i] for i in order]


async def keyword_ranking(query: str, chunks: list[dict], top_k: int) -> list[str]:
    """近似生产关键词路：DeepSeek 提词后词面匹配（生产为 Milvus LIKE，无相关性分数），
    这里按命中关键词数降序近似排序。"""
    keywords = await extract_keywords(query)
    if not keywords:
        return []
    lowered = [k.lower() for k in keywords]
    scored = []
    for ch in chunks:
        text = ch["docText"].lower()
        hits = sum(1 for k in lowered if k in text)
        if hits > 0:
            scored.append((hits, ch["chunkKey"]))
    scored.sort(key=lambda x: -x[0])
    return [key for _, key in scored[:top_k]]


def evaluate(rankings: dict[str, list[str]], gold: dict[str, str], k_list=(1, 3, 5)) -> dict:
    recall = {k: 0 for k in k_list}
    rr_total = 0.0
    for qid, ranking in rankings.items():
        g = gold[qid]
        for k in k_list:
            if g in ranking[:k]:
                recall[k] += 1
        if g in ranking:
            rr_total += 1.0 / (ranking.index(g) + 1)
    n = len(rankings)
    return {**{f"recall@{k}": recall[k] / n for k in k_list}, "mrr@5": rr_total / n, "n": n}


async def main() -> None:
    chunks = load_json("chunks.json")
    qa_index = load_json("qa_index.json")
    eval_queries = load_json("eval_queries.json")
    chunk_vectors = np.load(DATA_DIR / "chunk_vectors.npy")
    qa_vectors = np.load(DATA_DIR / "qa_vectors.npy")
    query_vectors = np.load(DATA_DIR / "query_vectors.npy")

    chunk_ids = [c["chunkKey"] for c in chunks]
    chunk_by_id = {c["chunkKey"]: c for c in chunks}

    # QA 路索引：问题 → 源 chunk 映射（与 qa_vectors 行序一致）
    q_to_chunk: list[str] = []
    for item in qa_index:
        q_to_chunk.extend([item["chunkKey"]] * len(item["questions"]))
    assert len(q_to_chunk) == qa_vectors.shape[0], "问题与向量数量不一致，请重跑 gen_qa_index.py"

    gold = {q["queryId"]: q["chunkKey"] for q in eval_queries}
    print(f"查询数: {len(eval_queries)}，chunk 数: {len(chunks)}，索引问题数: {len(q_to_chunk)}")

    # ---------- 各路检索 ----------
    sem = asyncio.Semaphore(8)

    async def kw_rank(q: str) -> list[str]:
        async with sem:
            return await keyword_ranking(q, chunks, TOP_K)

    keyword_jobs = [kw_rank(q["query"]) for q in eval_queries]
    keyword_ranks = await asyncio.gather(*keyword_jobs)

    arms: dict[str, dict[str, list[str]]] = {
        "A_chunk_vec": {},
        "B_qa": {},
        "C_chunk+qa": {},
        "D_prod_hybrid": {},
        "E_prod+qa": {},
    }
    for i, q in enumerate(eval_queries):
        qid, qv = q["queryId"], query_vectors[i]
        rank_a = cosine_ranking(qv, chunk_vectors, chunk_ids, TOP_K)

        # B：问题级匹配 → 映射回 chunk，去重保序
        q_rank = cosine_ranking(qv, qa_vectors, list(range(len(q_to_chunk))), TOP_K * 2)
        rank_b = list(OrderedDict.fromkeys(q_to_chunk[j] for j in q_rank))[:TOP_K]

        rank_d = rrf_fuse([rank_a, keyword_ranks[i]], [0.7, 0.3])

        arms["A_chunk_vec"][qid] = rank_a
        arms["B_qa"][qid] = rank_b
        arms["C_chunk+qa"][qid] = rrf_fuse([rank_a, rank_b], [0.5, 0.5])
        arms["D_prod_hybrid"][qid] = rank_d
        arms["E_prod+qa"][qid] = rrf_fuse([rank_d, rank_b], [0.5, 0.5])

    # ---------- 指标 ----------
    metrics = {name: evaluate(rankings, gold) for name, rankings in arms.items()}
    print(json.dumps(metrics, ensure_ascii=False, indent=2))

    # ---------- 差异样本：QA 赢 / 输 ----------
    qa_wins, qa_losses = [], []
    for q in eval_queries:
        qid = q["queryId"]
        a, b = arms["A_chunk_vec"][qid], arms["B_qa"][qid]
        g = gold[qid]
        ra = a.index(g) + 1 if g in a else 99
        rb = b.index(g) + 1 if g in b else 99
        rec = {"query": q["query"], "goldRank_chunkVec": ra, "goldRank_qa": rb, "doc": q["docTitle"]}
        if rb < ra and rb <= 5:
            qa_wins.append(rec)
        elif ra < rb and ra <= 5:
            qa_losses.append(rec)
    qa_wins.sort(key=lambda x: x["goldRank_chunkVec"] - x["goldRank_qa"])
    qa_losses.sort(key=lambda x: x["goldRank_qa"] - x["goldRank_chunkVec"])

    out = {
        "metrics": metrics,
        "numQueries": len(eval_queries),
        "numChunks": len(chunks),
        "numIndexQuestions": len(q_to_chunk),
        "qa_wins_sample": qa_wins[:15],
        "qa_losses_sample": qa_losses[:15],
        "arm_rankings_sample": {
            name: {q["queryId"]: rankings[q["queryId"]][:5] for q in eval_queries[:5]}
            for name, rankings in arms.items()
        },
    }
    save_json("recall_eval_results.json", out)
    (Path(__file__).resolve().parent.parent / "RECALL_EVAL_RESULTS.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("评测完成，结果已写入 eval/data/recall_eval_results.json")


if __name__ == "__main__":
    asyncio.run(main())
