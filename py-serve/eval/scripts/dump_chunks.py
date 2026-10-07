"""从 Milvus 拉取指定用户集合的全部 chunk（文本 + 生产环境已存向量）作为评测语料。

用法: python eval/scripts/dump_chunks.py [collection_name]
不传集合名时默认取 chunk 数最多的用户集合。
"""
import asyncio
import sys
from pathlib import Path

import numpy as np
from pymilvus import MilvusClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import DATA_DIR, save_json  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))


def main(collection: str | None) -> None:
    client = MilvusClient(uri="http://127.0.0.1:19530")
    cols = client.list_collections()
    if collection:
        assert collection in cols, f"集合不存在: {collection}"
    else:
        # 取行数最多的用户集合
        best, best_n = None, -1
        for col in cols:
            rows = client.query(collection_name=col, filter='docId != ""', output_fields=["docId"], limit=16384)
            if len(rows) > best_n:
                best, best_n = col, len(rows)
        collection = best
    print(f"评测语料集合: {collection}")

    rows = client.query(
        collection_name=collection,
        filter='docId != ""',
        output_fields=["id", "docId", "docTitle", "docText", "docVector"],
        limit=16384,
    )
    rows.sort(key=lambda r: (r["docId"], r["id"]))
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
    vectors = np.array([r["docVector"] for r in rows], dtype=np.float32)
    print(f"chunks: {len(chunks)}, 向量维度: {vectors.shape}")

    save_json("chunks.json", chunks)
    np.save(DATA_DIR / "chunk_vectors.npy", vectors)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
