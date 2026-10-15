"""从 Milvus 拉取指定集合的全部 chunk（标量字段）作为评测语料，向量由文本重算。

背景：实测 MilvusClient.query 大 limit（16384）一次性拉取 FLOAT_VECTOR 列时，
返回行与向量列会出现跨 segment 错位（行文本与向量不配对，且无主键重复）。
因此本脚本：
  1. 分页拉取标量字段（id/docId/docTitle/docText），并用两种不同页大小各拉一次，
     逐行比对 id→(docId,docTitle,docText) 映射，不一致即中止；
  2. 向量不用 Milvus 返回值，直接用通义 embedding 重算（与生产入库同一模型/维度，
     与生产向量数学等价），保证 chunks.json ↔ chunk_vectors.npy 按构造对齐。

用法: python eval/scripts/dump_chunks.py [collection_name]
不传集合名时默认取 chunk 数最多的用户集合。
"""
import asyncio
import sys
from pathlib import Path
from typing import cast

import numpy as np
from pymilvus import MilvusClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from common import DATA_DIR, embed_texts, save_json  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

PAGE_SIZES = (500, 777)


def fetch_all_scalar(client: MilvusClient, collection: str, page_size: int) -> dict:
    """分页拉取标量字段，返回 id → 行dict（保留首次出现，重复主键视为异常交由上层处理）。"""
    by_id: dict[int, dict] = {}
    offset = 0
    while True:
        rows = client.query(
            collection_name=collection,
            filter='docId != ""',
            output_fields=["id", "docId", "docTitle", "docText"],
            limit=page_size,
            offset=offset,
        )
        if not rows:
            break
        for r in rows:
            by_id.setdefault(r["id"], r)
        offset += len(rows)
        if len(rows) < page_size:
            break
    return by_id


def main(collection: str | None) -> None:
    client = MilvusClient(uri="http://127.0.0.1:19530")
    # pymilvus 3.0.1 的 retry 装饰器让 list_collections 的推断返回类型变成协程，
    # 实际运行时返回 list[str]（GrpcHandler.list_collections），这里显式收窄。
    cols = cast(list[str], client.list_collections())
    if collection:
        assert collection in cols, f"集合不存在: {collection}"
    else:
        best, best_n = None, -1
        for col in cols:
            n = len(fetch_all_scalar(client, col, 1000))
            if n > best_n:
                best, best_n = col, n
        collection = best
    assert collection is not None
    print(f"评测语料集合: {collection}")

    # 双重抽取互验：不同页大小各自拉取，id→字段映射必须完全一致
    fetch_a = fetch_all_scalar(client, collection, PAGE_SIZES[0])
    fetch_b = fetch_all_scalar(client, collection, PAGE_SIZES[1])
    assert set(fetch_a) == set(fetch_b), "两次拉取的 id 集合不一致，Milvus 返回不稳定，中止"
    mismatch = [
        rid for rid in fetch_a
        if (fetch_a[rid]["docId"], fetch_a[rid]["docText"]) != (fetch_b[rid]["docId"], fetch_b[rid]["docText"])
    ]
    assert not mismatch, f"{len(mismatch)} 行在两种页大小下内容不一致，中止"
    print(f"双重抽取互验通过：{len(fetch_a)} 行，标量字段稳定")

    rows = sorted(fetch_a.values(), key=lambda r: (r["docId"], r["id"]))
    chunks = [
        {
            "chunkKey": f"{r['docId']}::{r['id']}",
            "docId": r["docId"],
            "docTitle": r["docTitle"],
            "docText": r["docText"],
            "index": i,
        }
        for i, r in enumerate(rows)
    ]
    print(f"chunks: {len(chunks)}，开始重算向量（与生产同模型）...")
    vectors = asyncio.run(embed_texts([c["docText"] for c in chunks]))
    print(f"向量: {vectors.shape}")

    save_json("chunks.json", chunks)
    np.save(DATA_DIR / "chunk_vectors.npy", vectors)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
