"""Milvus 向量集合操作：建集合、插入、向量检索、关键词（LIKE）检索、删除。

每用户一个集合，集合名带 schema 版本 `_<userId>_v3`：
  id Int64 主键（手动生成）/ docId / docTitle / docText / docVector FloatVector
  parentId VARCHAR / chunkKey VARCHAR / chunkIndex INT64 / section VARCHAR
  page INT64 / para INT64 / charStart INT64 / charEnd INT64

v3 在 v2 溯源字段基础上增加 parentId（父章节，正文在 MongoDB `file_sections`）。
Milvus 不支持给已有集合加列，因此用新集合名做无损升级（旧集合保留不删），
存量文件用 `scripts/reindex_kb.py` 从 MongoDB 全文重建。
"""
import random
import time
from typing import Any, cast

from pymilvus import DataType, MilvusClient

from ..core.config import Config
from ..core.response import BizError

milvus_client: MilvusClient | None = None


def get_milvus() -> MilvusClient:
    global milvus_client
    if milvus_client is None:
        milvus_client = MilvusClient(uri=f"http://{Config.MILVUS_ADDRESS}")
    return milvus_client


SCHEMA_VERSION = "v3"


def collection_name_for(user_id: str) -> str:
    return f"_{user_id}_{SCHEMA_VERSION}"


def create_collection(client: MilvusClient, name: str) -> None:
    dim = Config.QWEN_EMBEDDING_DIMENSIONS
    schema = client.create_schema(auto_id=False, enable_dynamic_field=False)
    schema.add_field("id", DataType.INT64, is_primary=True, description="主键id字段")
    schema.add_field("docId", DataType.VARCHAR, max_length=100, description="文档id字段")
    schema.add_field("docTitle", DataType.VARCHAR, max_length=500, description="文档标题")
    schema.add_field("docText", DataType.VARCHAR, max_length=9000, description="文档切块的片段")
    # 溯源字段：回答里的 [N] 通过 chunkKey/section/page/para 回指到原文位置
    schema.add_field("parentId", DataType.VARCHAR, max_length=200, description="父章节 id")
    schema.add_field("chunkKey", DataType.VARCHAR, max_length=200, description="文档内切片唯一键")
    schema.add_field("chunkIndex", DataType.INT64, description="切片在文档内的序号")
    schema.add_field("section", DataType.VARCHAR, max_length=500, description="章节路径")
    schema.add_field("page", DataType.INT64, description="起始页码，0=未知")
    schema.add_field("para", DataType.INT64, description="章节内段序，0=未知")
    schema.add_field("charStart", DataType.INT64, description="全文起始字符偏移")
    schema.add_field("charEnd", DataType.INT64, description="全文结束字符偏移")
    schema.add_field("docVector", DataType.FLOAT_VECTOR, dim=dim, description="文档内容的向量")

    index_params = client.prepare_index_params()
    index_params.add_index(
        field_name="docVector",
        index_type="IVF_FLAT",
        metric_type="COSINE",
        params={"nlist": 128},
    )

    client.create_collection(collection_name=name, schema=schema, index_params=index_params)
    client.load_collection(collection_name=name)


REQUIRED_FIELDS = {
    "id", "docId", "docTitle", "docText", "docVector", "parentId",
    "chunkKey", "chunkIndex", "section", "page", "para", "charStart", "charEnd",
}

# 检索时统一取回的标量字段（溯源信息与文本一起返回，省一次回表）
_OUTPUT_FIELDS = [
    "docId", "docTitle", "docText", "parentId",
    "chunkKey", "chunkIndex", "section", "page", "para", "charStart", "charEnd",
]
_PROVENANCE_FIELDS = (
    "parentId", "chunkKey", "chunkIndex", "section", "page", "para", "charStart", "charEnd",
)


def _provenance(row: dict) -> dict:
    return {key: row.get(key) for key in _PROVENANCE_FIELDS}


def _collection_schema(client: MilvusClient, name: str) -> tuple[int | None, set[str]]:
    # pymilvus 3.0.1 的 retry 装饰器让 describe_collection 的推断返回类型变成协程，
    # 实际运行时返回 dict（MilvusClient.describe_collection），这里显式收窄。
    desc = cast(dict[str, Any], client.describe_collection(collection_name=name))
    fields = {field.get("name") for field in desc.get("fields", [])}
    dim: int | None = None
    for field in desc.get("fields", []):
        if field.get("name") == "docVector":
            params = field.get("params") or {}
            raw_dim = params.get("dim")
            if raw_dim is not None:
                try:
                    dim = int(raw_dim)
                except (TypeError, ValueError):
                    dim = None
    return dim, fields


def ensure_collection(client: MilvusClient, name: str) -> None:
    """集合不存在则创建；字段或维度与当前定义不符则删除重建。

    集合名已带 schema 版本，正常升级走新集合，不会触发这里的重建；
    重建只用于同一版本内改字段（开发期）或维度配置变更。
    """
    if not client.has_collection(collection_name=name):
        create_collection(client, name)
        return
    current_dim, fields = _collection_schema(client, name)
    missing = REQUIRED_FIELDS - fields
    dim_changed = current_dim is not None and current_dim != Config.QWEN_EMBEDDING_DIMENSIONS
    if missing or dim_changed:
        print(
            f"集合 {name} 结构不兼容，删除重建"
            f"（缺失字段 {sorted(missing)}，维度 {current_dim} → {Config.QWEN_EMBEDDING_DIMENSIONS}）"
        )
        client.drop_collection(collection_name=name)
        create_collection(client, name)


def insert_chunks(
    doc_id: str,
    doc_title: str,
    chunks: list[str],
    vectors: list[list[float]],
    user_id: str,
    metas: list[dict] | None = None,
) -> dict:
    """切片入库（调用方先算好向量）：Milvus 同步 SDK，须在线程池中运行。

    metas 与 chunks 一一对应（structure.ChunkSpan.to_meta 的产物）；缺省时填默认值，
    兼容评测脚本这类不需要溯源信息的调用方。
    """
    client = get_milvus()
    name = collection_name_for(user_id)
    ensure_collection(client, name)

    now_ms = int(time.time() * 1000)
    rows = []
    for index, chunk in enumerate(chunks):
        meta = metas[index] if metas and index < len(metas) else {}
        rows.append(
            {
                # 手动生成 Int64 主键：毫秒时间戳 * 100000 + 序号 * 1000 + 随机数，避免冲突
                "id": now_ms * 100000 + index * 1000 + random.randint(0, 999),
                "docId": doc_id,
                "docTitle": doc_title,
                "docText": chunk,
                "parentId": meta.get("parentId") or f"{doc_id}#s0",
                "chunkKey": meta.get("chunkKey") or f"{doc_id}#{index}",
                "chunkIndex": int(meta.get("chunkIndex", index)),
                "section": (meta.get("section") or "正文")[:500],
                "page": int(meta.get("page") or 0),
                "para": int(meta.get("para") or 0),
                "charStart": int(meta.get("charStart") or 0),
                "charEnd": int(meta.get("charEnd") or 0),
                "docVector": vectors[index],
            }
        )
    result = client.insert(collection_name=name, data=rows)
    client.flush(collection_name=name)
    return {"inserted": len(rows), "collection": name, "result": result}


def vector_search(query_vector: list[float], user_id: str, limit: int = 10) -> list[dict]:
    client = get_milvus()
    name = collection_name_for(user_id)
    if not client.has_collection(collection_name=name):
        raise BizError("用户向量集合不存在", 400)
    results = client.search(
        collection_name=name,
        data=[query_vector],
        anns_field="docVector",
        search_params={"metric_type": "COSINE", "params": {"nprobe": 10}},
        limit=limit,
        output_fields=_OUTPUT_FIELDS,
    )
    normalized: list[dict] = []
    for hits in results:
        for hit in hits:
            entity = hit.get("entity") or {}
            normalized.append(
                {
                    "id": hit.get("id"),
                    "docId": entity.get("docId"),
                    "docTitle": entity.get("docTitle"),
                    "docText": entity.get("docText"),
                    **_provenance(entity),
                    "score": hit.get("distance", 0),
                }
            )
    return normalized


def keyword_query(filter_expr: str, user_id: str, limit: int = 10) -> list[dict]:
    client = get_milvus()
    name = collection_name_for(user_id)
    rows = client.query(
        collection_name=name,
        filter=filter_expr,
        limit=limit,
        output_fields=_OUTPUT_FIELDS,
    )
    return [
        {
            "id": row.get("id"),
            "docId": row.get("docId"),
            "docTitle": row.get("docTitle"),
            "docText": row.get("docText"),
            **_provenance(row),
        }
        for row in rows
    ]


def delete_by_doc_id(doc_id: str, user_id: str) -> None:
    client = get_milvus()
    name = collection_name_for(user_id)
    if not client.has_collection(collection_name=name):
        return
    client.delete(collection_name=name, filter=f'docId == "{doc_id}"')
