"""父文档（章节）存储：子块命中后按 parentId 回表取上下文。

Milvus 只存子块与向量，父章节文本放在 MongoDB：
  - 章节可能上万字，超过 Milvus VARCHAR(9000) 上限；
  - 父文档不参与向量检索，只在生成阶段补上下文，用 Mongo 批量 $in 查询即可。
"""
from pymongo.asynchronous.collection import AsyncCollection

from .structure import DocSection

SECTION_COLLECTION = "file_sections"


async def replace_sections(
    sections_col: AsyncCollection,
    user_id: str,
    doc_id: str,
    doc_title: str,
    sections: list[DocSection],
) -> int:
    """重建某篇文档的父章节（先删后插，保证重复入库不会残留旧章节）。"""
    await sections_col.delete_many({"userId": user_id, "docId": doc_id})
    if not sections:
        return 0
    await sections_col.create_index([("userId", 1), ("docId", 1)])
    await sections_col.create_index([("userId", 1), ("parentId", 1)])
    await sections_col.insert_many([s.to_mongo(doc_id, user_id, doc_title) for s in sections])
    return len(sections)


async def delete_sections(sections_col: AsyncCollection, user_id: str, doc_id: str) -> None:
    await sections_col.delete_many({"userId": user_id, "docId": doc_id})


async def get_sections_by_ids(
    sections_col: AsyncCollection, user_id: str, parent_ids: list[str]
) -> dict[str, dict]:
    """批量取父章节，返回 parentId → 文档；查不到的 id 直接缺省（调用方降级为子块文本）。"""
    ids = list(dict.fromkeys(pid for pid in parent_ids if pid))
    if not ids:
        return {}
    cursor = sections_col.find(
        {"userId": user_id, "parentId": {"$in": ids}},
        {
            "_id": 0,
            "parentId": 1,
            "docId": 1,
            "docTitle": 1,
            "path": 1,
            "start": 1,
            "end": 1,
            "pageStart": 1,
            "pageEnd": 1,
            "text": 1,
        },
    )
    return {doc["parentId"]: doc async for doc in cursor}
