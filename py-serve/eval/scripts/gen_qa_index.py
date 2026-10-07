"""为每个 chunk 生成「QA 召回索引」：大段 → 模型生成多个索引问题 → 向量化。

索引问题风格：信息密集、术语规范（与用户查询集的口语风格刻意区分，且使用不同模型生成，
降低同源偏差）。产出:
  eval/data/qa_index.json   [{chunkKey, questions: [...]}]
  eval/data/qa_vectors.npy  与全部索引问题顺序对应的向量

用法: python eval/scripts/gen_qa_index.py
"""
import asyncio
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from common import DATA_DIR, ds_chat, embed_texts, load_json, parse_json_object, save_json  # noqa: E402

from app.config import Config  # noqa: E402

SYSTEM_PROMPT = """你在为科研知识库构建「问题检索索引」。给定一个文档片段，生成 4~6 个该片段能直接回答的问题，作为检索索引。
要求：
1. 问题信息密集、使用规范学术术语，覆盖片段的不同侧面（定义/方法/数据/结论等）；
2. 每个问题聚焦单一知识点，必须能仅凭该片段回答；
3. 不要照抄片段原句，改成疑问句形式；
4. 只输出 JSON：{"questions": ["问题1", "问题2", ...]}"""

CONCURRENCY = 8


async def gen_one(chunk: dict, sem: asyncio.Semaphore) -> dict:
    user = f"【文档：{chunk['docTitle']}】\n片段内容：\n{chunk['docText']}"
    raw = await ds_chat(Config.DEEPSEEK_MODEL, SYSTEM_PROMPT, user, 0.6, sem)
    questions = parse_json_object(raw).get("questions", [])
    questions = [q.strip() for q in questions if isinstance(q, str) and q.strip()][:6]
    return {"chunkKey": chunk["chunkKey"], "questions": questions}


async def main() -> None:
    chunks = load_json("chunks.json")
    qa_path = DATA_DIR / "qa_index.json"
    if qa_path.exists():
        qa_index = json.loads(qa_path.read_text(encoding="utf-8"))
        done = {item["chunkKey"] for item in qa_index}
    else:
        qa_index, done = [], set()
    todo = [c for c in chunks if c["chunkKey"] not in done]
    print(f"chunks: {len(chunks)}，已生成: {len(done)}，待生成: {len(todo)}")

    sem = asyncio.Semaphore(CONCURRENCY)
    results = await asyncio.gather(*(gen_one(c, sem) for c in todo))
    qa_index.extend(r for r in results if r["questions"])

    empty = [r["chunkKey"] for r in results if not r["questions"]]
    if empty:
        print(f"警告: {len(empty)} 个 chunk 生成失败或为空")
    save_json("qa_index.json", qa_index)

    # 向量化全部索引问题
    all_questions: list[str] = []
    for item in qa_index:
        all_questions.extend(item["questions"])
    print(f"索引问题总数: {len(all_questions)}，开始向量化...")
    vectors = await embed_texts(all_questions)
    np.save(DATA_DIR / "qa_vectors.npy", vectors)
    print(f"向量: {vectors.shape}")


if __name__ == "__main__":
    asyncio.run(main())
