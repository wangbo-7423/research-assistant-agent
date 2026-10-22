"""知识库索引重建：为存量文件补齐 v3 父子结构（parentId + 父章节）。

Milvus 不支持给已有集合加列，本次升级把集合名改为 `_<userId>_v3`（旧集合保留不删），
因此升级后存量文件不会自动出现在新集合里，需要用本脚本重建一次。

数据来源是 MongoDB 的 `fileanagements.fileText`（上传时已存全文）与 `pageStarts`
（PDF 每页起始偏移），重建流程与线上上传完全一致：
split_document_with_sections → embedding → insert_chunks + file_sections，
所以章节/页码标注与新上传文件一致；早期没有 pageStarts 的文档页码为 0。

用法：
  python scripts/reindex_kb.py                     # 重建全部用户
  python scripts/reindex_kb.py --user-id xxx       # 只重建指定用户
  python scripts/reindex_kb.py --prune-legacy      # 重建成功后删除该用户旧版本集合
"""
import argparse
import asyncio
import logging
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import cast

from pymongo import AsyncMongoClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import Config  # noqa: E402
from app.file_management import milvus_store, qa_index  # noqa: E402
from app.file_management.embeddings import embedding_client  # noqa: E402
from app.file_management.sections import SECTION_COLLECTION, replace_sections  # noqa: E402
from app.file_management.service import FILE_COLLECTION  # noqa: E402
from app.file_management.structure import split_document_with_sections  # noqa: E402


def log(message: str) -> None:
    # 重建是长任务，逐条 flush，避免看起来像卡死
    print(message, flush=True)


async def reindex_document(sections_col, doc: dict, user_id: str, skip_qa: bool) -> tuple[int, int]:
    doc_id = str(doc["_id"])
    title = doc.get("fileName") or doc_id
    text = doc.get("fileText") or ""
    page_starts = doc.get("pageStarts") or []

    spans, doc_sections = split_document_with_sections(
        text, page_starts, chunk_size=800, chunk_overlap=100
    )
    # 先清旧向量/QA/父章节，保证脚本可重复执行
    await asyncio.to_thread(milvus_store.delete_by_doc_id, doc_id, user_id)
    if not skip_qa:
        await asyncio.to_thread(qa_index.delete_by_doc_id, doc_id, user_id)
    await replace_sections(sections_col, user_id, doc_id, title, doc_sections)
    if not spans:
        log(f"  跳过（无有效文本）: {title}")
        return 0, 0

    texts = [span.text if span.text.strip() else " " for span in spans]
    vectors = await embedding_client.embed_documents(texts)
    metas = [span.to_meta(doc_id) for span in spans]

    await asyncio.to_thread(
        milvus_store.insert_chunks, doc_id, title, [s.text for s in spans], vectors, user_id, metas
    )
    qa_count = 0
    if not skip_qa:
        log(f"  构建 QA 索引: {title}（{len(spans)} chunks）...")
        qa_count = await qa_index.build_index(doc_id, title, spans, user_id)
    log(f"  重建完成: {title} → {len(spans)} chunks / {len(doc_sections)} sections / {qa_count} questions")
    return len(spans), qa_count


def legacy_collections(user_id: str) -> list[str]:
    """该用户所有旧版本集合（_uid、_uid_v1/_v2…），排除当前版本。"""
    current = milvus_store.collection_name_for(user_id)
    pattern = re.compile(rf"^_{re.escape(user_id)}(?:_v\d+)?$")
    names = cast(list[str], milvus_store.get_milvus().list_collections())
    return sorted(name for name in names if name != current and pattern.match(name))


async def main(user_id: str | None, prune_legacy: bool = False, skip_qa: bool = False) -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    # 单独建客户端并缩短选主超时：基础设施没起时快速报错，而不是静默等 30 秒
    client = AsyncMongoClient(Config.MONGODB_URI, serverSelectionTimeoutMS=8000)
    db = client.get_default_database()
    files_col = db[FILE_COLLECTION]
    sections_col = db[SECTION_COLLECTION]

    log(f"连接 MongoDB（{Config.MONGODB_URI.rsplit('@', 1)[-1]}）...")
    try:
        await db.command("ping")
    except Exception as exc:
        await client.close()
        log(
            "MongoDB 连接失败，脚本无法继续。请先启动基础设施：\n"
            "  cd py-serve && docker compose up -d\n"
            f"原始错误: {exc}"
        )
        raise SystemExit(1)

    try:
        if user_id:
            user_ids = [user_id]
        else:
            user_ids = await files_col.distinct("userId", {"uploadType": "UD"})
        log(f"待处理用户: {len(user_ids)} 个")

        total_docs = total_chunks = total_questions = 0
        for current_user in user_ids:
            cursor = files_col.find({"userId": current_user, "uploadType": "UD"})
            docs = [doc async for doc in cursor]
            if not docs:
                continue
            log(f"用户 {current_user}: {len(docs)} 个知识库文件")
            user_chunks = 0
            for doc in docs:
                chunks_n, qa_n = await reindex_document(
                    sections_col, doc, str(current_user), skip_qa
                )
                user_chunks += chunks_n
                total_questions += qa_n
                total_docs += 1
                if not skip_qa:
                    await files_col.update_one(
                        {"_id": doc["_id"]},
                        {
                            "$set": {
                                "qaStatus": "ready",
                                "qaBuiltAt": datetime.now(),
                                "qaQuestions": qa_n,
                                "updatedAt": datetime.now(),
                            }
                        },
                    )
            total_chunks += user_chunks

            # 只有本用户全部重建成功（有切片）才清理旧集合，避免把还没重建的数据删掉
            if prune_legacy and user_chunks > 0:
                for name in legacy_collections(str(current_user)):
                    milvus_store.get_milvus().drop_collection(collection_name=name)
                    log(f"  已清理旧集合: {name}")

        log(
            f"完成：{total_docs} 个文件，{total_chunks} 个切片，"
            f"{total_questions} 个 QA 问题，集合版本 {milvus_store.SCHEMA_VERSION}"
        )
    finally:
        await client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="重建知识库向量索引（含溯源字段）")
    parser.add_argument("--user-id", default=None, help="只重建指定用户，缺省为全部用户")
    parser.add_argument(
        "--prune-legacy",
        action="store_true",
        help="重建成功后删除该用户的旧版本集合（_uid、_uid_v1/_v2…）",
    )
    parser.add_argument("--skip-qa", action="store_true", help="不重建 QA 问题索引（只重建 chunk 向量）")
    args = parser.parse_args()
    asyncio.run(main(args.user_id, args.prune_legacy, args.skip_qa))
