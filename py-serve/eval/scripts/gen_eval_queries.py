"""生成「用户风格」评测查询集（模拟真实用户提问），并标注金标 chunk。

与 QA 索引刻意隔离以控制偏差：
  - 不同模型生成（索引用 deepseek-flash，本脚本用 deepseek-v4-pro）；
  - 不同提示词风格（口语化、同义改写、模糊指代，禁止照抄原文措辞）。

产出:
  eval/data/eval_queries.json  [{queryId, chunkKey, docTitle, query}]
  eval/data/query_vectors.npy

用法: python eval/scripts/gen_eval_queries.py
"""
import asyncio
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from common import DATA_DIR, ds_chat, embed_texts, load_json, parse_json_object, save_json  # noqa: E402

EVAL_MODEL = "deepseek-v4-pro"  # 与索引生成模型不同，降低同源风格泄漏

SYSTEM_PROMPT = """你负责为科研问答系统构造「真实用户测试问题」。给定一个文档片段，站在用户角度写 2 个他可能会向 AI 科研助手提出的口语化问题。
要求：
1. 语气自然随意，像真人打字，可以用同义词、简称、缩写或模糊表述；
2. 禁止照抄片段中的原句措辞，必须换一种说法；
3. 问题答案应当主要来自这个片段；
4. 两个问题要问片段的不同侧面；
5. 只输出 JSON：{"queries": ["问题1", "问题2"]}"""

CONCURRENCY = 8


async def gen_one(chunk: dict, sem: asyncio.Semaphore) -> list[dict]:
    user = f"【文档：{chunk['docTitle']}】\n片段内容：\n{chunk['docText']}"
    raw = await ds_chat(EVAL_MODEL, SYSTEM_PROMPT, user, 0.9, sem)
    queries = parse_json_object(raw).get("queries", [])
    return [
        {
            "queryId": f"{chunk['chunkKey']}::q{i}",
            "chunkKey": chunk["chunkKey"],
            "docTitle": chunk["docTitle"],
            "query": q.strip(),
        }
        for i, q in enumerate(queries)
        if isinstance(q, str) and q.strip()
    ]


async def main() -> None:
    chunks = load_json("chunks.json")
    print(f"chunks: {len(chunks)}")
    sem = asyncio.Semaphore(CONCURRENCY)
    results = await asyncio.gather(*(gen_one(c, sem) for c in chunks))
    eval_queries = [q for group in results for q in group]
    print(f"评测查询总数: {len(eval_queries)}")
    save_json("eval_queries.json", eval_queries)

    vectors = await embed_texts([q["query"] for q in eval_queries])
    np.save(DATA_DIR / "query_vectors.npy", vectors)
    print(f"查询向量: {vectors.shape}")


if __name__ == "__main__":
    asyncio.run(main())
