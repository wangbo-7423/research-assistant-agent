"""Milvus 向量集合操作：建集合、插入、向量检索、关键词（LIKE）检索、删除。

集合结构与 NestJS 版完全一致（每用户一个集合 `_<userId>`）：
  id Int64 主键（手动生成）/ docId / docTitle / docText / docVector FloatVector
"""
import random
import time

from pymilvus import DataType, MilvusClient

from ..config import Config
from ..response import BizError

milvus_client: MilvusClient | None = None


def get_milvus() -> MilvusClient:
    global milvus_client
    if milvus_client is None:
        milvus_client = MilvusClient(uri=f"http://{Config.MILVUS_ADDRESS}")
    return milvus_client


def collection_name_for(user_id: str) -> str:
    return f"_{user_id}"


def create_collection(client: MilvusClient, name: str) -> None:
    dim = Config.QWEN_EMBEDDING_DIMENSIONS
    schema = client.create_schema(auto_id=False, enable_dynamic_field=False)
    schema.add_field("id", DataType.INT64, is_primary=True, description="主键id字段")
    schema.add_field("docId", DataType.VARCHAR, max_length=100, description="文档id字段")
    schema.add_field("docTitle", DataType.VARCHAR, max_length=500, description="文档标题")
    schema.add_field("docText", DataType.VARCHAR, max_length=9000, description="文档切块的片段")
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


def _collection_dim(client: MilvusClient, name: str) -> int | None:
    desc = client.describe_collection(collection_name=name)
    for field in desc.get("fields", []):
        if field.get("name") == "docVector":
            params = field.get("params") or {}
            try:
                return int(params.get("dim"))
            except (TypeError, ValueError):
                return None
    return None


def ensure_collection(client: MilvusClient, name: str) -> None:
    """集合不存在则创建；维度与当前配置不符则删除重建（与 NestJS 版迁移逻辑一致）。"""
    if not client.has_collection(collection_name=name):
        create_collection(client, name)
        return
    current_dim = _collection_dim(client, name)
    if current_dim is not None and current_dim != Config.QWEN_EMBEDDING_DIMENSIONS:
        print(
            f"集合 {name} 结构不兼容，删除重建"
            f"（维度 {current_dim} → {Config.QWEN_EMBEDDING_DIMENSIONS}）"
        )
        client.drop_collection(collection_name=name)
        create_collection(client, name)


def insert_chunks(doc_id: str, doc_title: str, chunks: list[str], vectors: list[list[float]], user_id: str) -> dict:
    """切片入库（调用方先算好向量）：Milvus 同步 SDK，须在线程池中运行。"""
    client = get_milvus()
    name = collection_name_for(user_id)
    ensure_collection(client, name)

    now_ms = int(time.time() * 1000)
    rows = [
        {
            # 手动生成 Int64 主键：毫秒时间戳 * 100000 + 序号 * 1000 + 随机数，避免冲突
            "id": now_ms * 100000 + index * 1000 + random.randint(0, 999),
            "docId": doc_id,
            "docTitle": doc_title,
            "docText": chunk,
            "docVector": vectors[index],
        }
        for index, chunk in enumerate(chunks)
    ]
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
        output_fields=["docId", "docTitle", "docText"],
    )
    normalized: list[dict] = []
    for hits in results:
        for hit in hits:
            entity = hit.get("entity", {}) if isinstance(hit, dict) else {}
            normalized.append(
                {
                    "id": hit.get("id"),
                    "docId": entity.get("docId"),
                    "docTitle": entity.get("docTitle"),
                    "docText": entity.get("docText"),
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
        output_fields=["docId", "docTitle", "docText"],
    )
    return [
        {
            "id": row.get("id"),
            "docId": row.get("docId"),
            "docTitle": row.get("docTitle"),
            "docText": row.get("docText"),
        }
        for row in rows
    ]


def delete_by_doc_id(doc_id: str, user_id: str) -> None:
    client = get_milvus()
    name = collection_name_for(user_id)
    if not client.has_collection(collection_name=name):
        return
    client.delete(collection_name=name, filter=f'docId == "{doc_id}"')
