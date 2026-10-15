"""把 docs/ 下的论文 PDF 批量导入一个专用评测集合（走生产的解析 + 切片 + 向量化 + 入库）。

产出单个 Milvus 集合 _evalcorpus，多文档混存（docId 前缀区分），并写 manifest
（chunk 数、文档清单）到 eval/data/corpus_manifest.json，供后续报告引用。

用法: python eval/scripts/ingest_corpus.py [--docs-dir ../../docs]
"""
import asyncio
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from common import embed_texts, save_json  # noqa: E402

from app.fileanagement import milvus_store  # noqa: E402
from app.fileanagement.parsers import parse_file  # noqa: E402
from app.fileanagement.splitter import recursive_character_split  # noqa: E402

EVAL_COLLECTION = "_evalcorpus"
EVAL_USER_ID = "evalcorpus"  # collection_name_for 会拼成 "_evalcorpus"
CHUNK_SIZE, CHUNK_OVERLAP = 800, 100  # 与生产一致
MIN_CHUNK_CHARS = 30  # 丢掉目录/页码等碎片

EXCLUDE_PATTERNS = ("面试题",)  # 试卷类 PDF 不入评测语料


def stable_doc_id(title: str) -> str:
    import hashlib

    return hashlib.md5(title.encode("utf-8")).hexdigest()[:16]


def main(docs_dir: Path) -> None:
    pdfs = sorted(p for p in docs_dir.glob("*.pdf") if not any(x in p.name for x in EXCLUDE_PATTERNS))
    print(f"待导入论文: {len(pdfs)} 篇（排除试卷类）")
    for p in pdfs:
        print("  -", p.name)

    client = milvus_store.get_milvus()
    existing_docs: dict[str, str] = {}
    if client.has_collection(collection_name=EVAL_COLLECTION):
        rows = client.query(
            collection_name=EVAL_COLLECTION, filter='docId != ""', output_fields=["docId", "docTitle"], limit=16384
        )
        for r in rows:
            existing_docs.setdefault(r["docTitle"], r["docId"])
    print(f"集合 {EVAL_COLLECTION} 已有文档: {len(existing_docs)}")

    new_docs: list[tuple[str, Path, str, list[str]]] = []  # (docId, path, title, chunks)
    for pdf in pdfs:
        title = pdf.stem
        if title in existing_docs:
            print(f"跳过（已入库）: {title}")
            continue
        text = parse_file(pdf.read_bytes(), "pdf")
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        chunks = [
            c.strip()
            for c in recursive_character_split(text, CHUNK_SIZE, CHUNK_OVERLAP)
            if len(c.strip()) >= MIN_CHUNK_CHARS
        ]
        doc_id = stable_doc_id(title)
        new_docs.append((doc_id, pdf, title, chunks))
        print(f"解析完成: {title} → {len(chunks)} chunks")

    if not new_docs:
        print("无新文档需要入库")
        return

    total_chunks = sum(len(d[3]) for d in new_docs)
    print(f"新文档 chunks 总数: {total_chunks}，开始向量化...")
    all_chunks = [c for _, _, _, chunks in new_docs for c in chunks]
    vectors = asyncio.run(embed_texts(all_chunks))
    print(f"向量: {vectors.shape}")

    milvus_store.ensure_collection(client, EVAL_COLLECTION)
    offset = 0
    manifest_docs = []
    for doc_id, _, title, chunks in new_docs:
        n = len(chunks)
        result = milvus_store.insert_chunks(doc_id, title, chunks, vectors[offset : offset + n].tolist(), EVAL_USER_ID)
        offset += n
        manifest_docs.append({"docId": doc_id, "title": title, "chunks": n})
        print(f"入库: {title} → {result}")

    save_json(
        "corpus_manifest.json",
        {"collection": EVAL_COLLECTION, "docs": manifest_docs, "totalChunks": total_chunks},
    )


if __name__ == "__main__":
    docs = Path(sys.argv[sys.argv.index("--docs-dir") + 1]) if "--docs-dir" in sys.argv else Path("../../docs")
    main(docs if docs.is_absolute() else (Path(__file__).resolve().parent.parent / docs).resolve())
