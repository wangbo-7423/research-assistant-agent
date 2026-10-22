"""文件管理服务：上传解析、切片向量化入库、检索（向量/关键词/混合 RRF）、删除。

对应 NestJS 版 FileanagementService（朴素 RAG 链路）。
"""
import asyncio
import logging
from datetime import datetime

from bson import ObjectId
from pymongo.asynchronous.collection import AsyncCollection

from ..core.config import Config
from ..core.response import BizError
from . import milvus_store
from .embeddings import embedding_client
from .keywords import extract_keywords
from .models import FileChunkSource, FileContent, FileDocument, FileListItem, FileRef, FileType, UploadType
from .parsers import parse_file_with_pages
from .sections import delete_sections, replace_sections
from .structure import split_document_with_sections

logger = logging.getLogger(__name__)

# MongoDB 集合名沿用历史拼写：已有上传记录都在这个集合里，
# 改名需要同步做数据迁移，否则存量知识库文件会「消失」。
FILE_COLLECTION = "fileanagements"

ALLOWED_DOC_TYPES = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
}
MAX_FILE_SIZE = 5 * 1024 * 1024  # 5MB
MAX_FILES = 3


def validate_doc_file(filename: str, mimetype: str, size: int) -> None:
    if mimetype not in ALLOWED_DOC_TYPES:
        raise BizError(f"不支持的文件类型: {mimetype}。仅支持 PDF 和 DOCX 文件", 400)
    if size > MAX_FILE_SIZE:
        raise BizError("文件大小不能超过 5MB", 400)


async def handle_upload(
    files: list[tuple[str, str, int, bytes]],
    user_id: str,
    upload_type: UploadType,
    files_col: AsyncCollection,
    sections_col: AsyncCollection,
) -> dict:
    """files: [(filename, mimetype, size, content)]；upload_type: UD=知识库 / UB=对话框。"""
    if not files:
        raise BizError("请至少上传一个文件", 400)
    results = await asyncio.gather(
        *(process_file(f, user_id, upload_type, files_col, sections_col) for f in files)
    )
    return {
        "success": True,
        "message": f"成功上传 {len(files)} 个文件",
        "files": [
            {"id": str(r["id"]), "fileName": r["fileName"], "fileSize": r["fileSize"], "fileType": r["fileType"]}
            for r in results
        ],
    }


async def process_file(
    file: tuple[str, str, int, bytes],
    user_id: str,
    upload_type: UploadType,
    files_col: AsyncCollection,
    sections_col: AsyncCollection,
) -> dict:
    filename, mimetype, size, content = file
    file_type: FileType = "pdf" if mimetype == "application/pdf" else "docx"

    # 1. 解析文件内容（CPU 密集，放线程池）；PDF 同时拿到每页起始偏移供溯源用
    merged_text, page_starts = await asyncio.to_thread(parse_file_with_pages, content, file_type)

    # 2. 保存文件到 MongoDB（只存文本，不存原始 Buffer）
    #    构造 FileDocument 即按文档结构校验，字段类型不对在入库前就会抛错
    now = datetime.now()
    doc = FileDocument(
        userId=user_id,
        fileName=filename,
        fileType=file_type,
        fileSize=size,
        fileText=merged_text,
        pageStarts=page_starts,
        uploadType=upload_type,
        createdAt=now,
        updatedAt=now,
    )
    result = await files_col.insert_one(doc.to_mongo())
    doc_id = str(result.inserted_id)

    # 3. 知识库上传时生成向量并存储到 Milvus，同时把父章节落 Mongo
    if upload_type == "UD" and merged_text.strip():
        spans, doc_sections = split_document_with_sections(
            merged_text, page_starts, chunk_size=800, chunk_overlap=100
        )
        if spans:
            texts = [s.text if s.text.strip() else " " for s in spans]
            vectors = await embedding_client.embed_documents(texts)
            metas = [s.to_meta(doc_id) for s in spans]
            await asyncio.to_thread(
                milvus_store.insert_chunks, doc_id, filename, [s.text for s in spans], vectors, user_id, metas
            )
        # 父章节只在生成阶段用：与子块分开存，避免 Milvus 的 VARCHAR 上限
        await replace_sections(sections_col, user_id, doc_id, filename, doc_sections)

    return {"id": doc_id, "fileName": filename, "fileSize": size, "fileType": file_type}


async def query_files_by_ids(
    user_id: str, doc_ids: list[ObjectId], files_col: AsyncCollection
) -> list[FileChunkSource]:
    cursor = files_col.find(
        {"userId": user_id, "_id": {"$in": doc_ids}},
        {"fileText": 1, "fileName": 1, "fileSize": 1, "fileType": 1},
    )
    return [FileChunkSource.from_mongo(doc) async for doc in cursor]


async def get_kb_file_list(user_id: str, files_col: AsyncCollection) -> list[dict]:
    cursor = files_col.find(
        {"userId": user_id, "uploadType": "UD"},
        {"fileName": 1, "fileSize": 1, "fileType": 1},
    )
    result = []
    async for doc in cursor:
        item = FileListItem.from_mongo(doc)
        result.append(
            {
                "id": str(item.id or doc["_id"]),
                "fileName": item.fileName,
                "fileSize": item.fileSize,
                "fileType": item.fileType,
            }
        )
    return result


async def get_file_content(file_id: str, files_col: AsyncCollection) -> dict:
    try:
        oid = ObjectId(file_id)
    except Exception:
        raise BizError("文件不存在", 400)
    doc = await files_col.find_one({"_id": oid})
    if not doc:
        raise BizError("文件不存在", 400)
    data = FileContent.from_mongo(doc)
    return {
        "id": str(data.id or doc["_id"]),
        "fileName": data.fileName,
        "fileText": data.fileText,
        "fileType": data.fileType,
        "fileSize": data.fileSize,
        "uploadType": data.uploadType,
    }


async def delete_file(
    file_id: str,
    user_id: str,
    expected_type: str | None,
    files_col: AsyncCollection,
    sections_col: AsyncCollection,
) -> dict:
    try:
        oid = ObjectId(file_id)
    except Exception:
        raise BizError("文件不存在或已被删除", 400)
    doc = await files_col.find_one({"_id": oid})
    if not doc:
        raise BizError("文件不存在或已被删除", 400)
    ref = FileRef.from_mongo(doc)
    if ref.userId != user_id:
        raise BizError("无权删除该文件", 400)
    if expected_type and ref.uploadType != expected_type:
        raise BizError("文件类型与删除接口不匹配", 400)

    # 知识库文件先删 Milvus 向量，成功后再删 MongoDB，避免向量残留
    if ref.uploadType == "UD":
        try:
            await asyncio.to_thread(milvus_store.delete_by_doc_id, file_id, user_id)
        except Exception as e:
            raise BizError(f"删除向量失败: {e}，请重试", 400)
        await delete_sections(sections_col, user_id, file_id)

    await files_col.delete_one({"_id": oid})
    return {"success": True, "message": "文件已删除"}


async def assert_file_ownership(file_id: str, user_id: str, files_col: AsyncCollection) -> dict:
    try:
        oid = ObjectId(file_id)
    except Exception:
        raise BizError("文件不存在或已被删除", 400)
    doc = await files_col.find_one({"_id": oid}, {"userId": 1, "uploadType": 1})
    if not doc:
        raise BizError("文件不存在或已被删除", 400)
    ref = FileRef.from_mongo(doc)
    if ref.userId != user_id:
        raise BizError("无权操作该文件", 400)
    return doc


# ---------------------------------------------------------------- 检索


async def vector_search(query: str, user_id: str, limit: int = 10) -> dict:
    try:
        query_vector = await embedding_client.embed_query(query)
        results = await asyncio.to_thread(
            milvus_store.vector_search, query_vector, user_id, limit
        )
        return {"success": True, "results": results}
    except BizError:
        raise
    except Exception as e:
        raise BizError(f"向量搜索失败: {e}", 400)


async def keyword_search(query: str, user_id: str, limit: int = 10) -> dict:
    name = milvus_store.collection_name_for(user_id)
    client = milvus_store.get_milvus()
    has_collection = await asyncio.to_thread(client.has_collection, collection_name=name)
    if not has_collection:
        return {"success": True, "results": []}

    keywords = await extract_keywords(query)
    if not keywords:
        return {"success": True, "results": []}

    escaped = [k.replace('"', "") for k in keywords]
    filter_expr = " or ".join(f'docText like "%{k}%"' for k in escaped)
    try:
        # 多取候选：Milvus query 无相关性排序，只按内部顺序返回，需在本地重排后再截断
        rows = await asyncio.to_thread(
            milvus_store.keyword_query, filter_expr, user_id, limit * 3
        )
    except Exception as e:
        raise BizError(f"关键词检索失败: {e}", 400)

    # 按「命中几个关键词」重建分数。Milvus query 不支持 order by，
    # 返回顺序与相关性无关，直接 1/(rank+1) 会把无关 chunk 排到前面。
    probes = [k.lower() for k in escaped]
    scored: list[dict] = []
    for row in rows:
        text_lower = (row.get("docText") or "").lower()
        hit = sum(1 for probe in probes if probe in text_lower)
        if hit:
            scored.append({**row, "score": hit})
    scored.sort(key=lambda item: item["score"], reverse=True)
    return {"success": True, "results": scored[:limit]}


_PROVENANCE_KEYS = (
    "parentId", "chunkKey", "chunkIndex", "section", "page", "para", "charStart", "charEnd",
)


def _fused_entry(item: dict) -> dict:
    """融合条目：保留两路检索的溯源字段，供回答阶段生成 citation。"""
    return {
        "docId": item.get("docId"),
        "docTitle": item.get("docTitle"),
        "docText": item.get("docText"),
        **{key: item.get(key) for key in _PROVENANCE_KEYS},
        "score": item.get("score", 0),
        "rrfScore": 0,
        "hitVector": False,
        "hitKeyword": False,
    }


def _rrf_fuse(vector_results: list[dict], keyword_results: list[dict], limit: int) -> list[dict]:
    """混合检索：向量 + 关键词，用倒数排名融合（RRF）。"""
    rrf_k = Config.RRF_K
    vector_weight = Config.VECTOR_WEIGHT
    keyword_weight = Config.KEYWORD_WEIGHT
    fused: dict[str, dict] = {}

    def key_of(item: dict) -> str:
        return f"{item.get('docId')}::{(item.get('docText') or '')[:50]}"

    for rank, item in enumerate(vector_results):
        if not item.get("docText"):
            continue
        entry = fused.setdefault(key_of(item), _fused_entry(item))
        entry["rrfScore"] += vector_weight / (rrf_k + rank + 1)
        entry["hitVector"] = True

    for rank, item in enumerate(keyword_results):
        if not item.get("docText"):
            continue
        entry = fused.setdefault(key_of(item), _fused_entry(item))
        entry["rrfScore"] += keyword_weight / (rrf_k + rank + 1)
        entry["hitKeyword"] = True

    return sorted(fused.values(), key=lambda x: x["rrfScore"], reverse=True)[:limit]


async def hybrid_search(query: str, user_id: str, limit: int = 5) -> dict:
    client = milvus_store.get_milvus()
    name = milvus_store.collection_name_for(user_id)
    has_collection = await asyncio.to_thread(client.has_collection, collection_name=name)
    if not has_collection:
        # 集合不存在不代表出错：用户还没有上传知识库文件
        return {"success": True, "results": [], "fromVector": 0, "fromKeyword": 0}

    candidate_limit = max(limit * 2, 10)

    # 两路检索并行，关键词检索失败不阻断主流程（降级为纯向量检索）
    vector_task = vector_search(query, user_id, candidate_limit)

    async def _safe_keyword():
        try:
            return await keyword_search(query, user_id, candidate_limit)
        except Exception as e:
            logger.warning("关键词检索失败，降级为纯向量检索: %s", e)
            return {"success": True, "results": []}

    vector_res, keyword_res = await asyncio.gather(vector_task, _safe_keyword())
    fused = _rrf_fuse(vector_res["results"], keyword_res["results"], limit)
    return {
        "success": True,
        "results": fused,
        "fromVector": len(vector_res["results"]),
        "fromKeyword": len(keyword_res["results"]),
    }
