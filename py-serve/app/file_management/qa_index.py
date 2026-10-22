"""QA 问题索引：为每个 chunk 预生成「用户可能问的问题」，单独建向量索引。

检索时做「问题对问题」匹配：query 向量命中问题 → 映射回源 chunk，
与 chunk 向量路做 RRF。离线实验（eval/README）在该项目语料上：
  chunk 向量 66.5% → QA 单路 73.2% → 双路融合 78.8%（Recall@5）。

存储上与 chunk 集合分开（`_<userId>_qa_v1`）：
  - 问题向量是 chunk 向量的 5~6 倍，混在一个集合里会让 chunk 检索的过滤/统计变复杂；
  - 问题行只存 chunkKey + 问题文本，正文仍以 chunk 集合为准，避免文本重复 5 份。
"""
import asyncio
import json
import logging
import random
import re
import time

from openai import AsyncOpenAI
from pymilvus import DataType, MilvusClient

from ..core.config import Config
from .embeddings import embedding_client
from .milvus_store import get_milvus

logger = logging.getLogger(__name__)

QA_SCHEMA_VERSION = "v1"
QUESTIONS_PER_CHUNK = 5
LLM_CONCURRENCY = 4
MAX_QUESTION_CHARS = 200
MAX_CHUNK_CHARS_FOR_PROMPT = 1200

_SYSTEM_PROMPT = (
    "你在为科研知识库构建「用户问题索引」。给定论文中的一个片段，生成 5 个用户可能会向 AI 科研助手提出的问题。"
    "要求：1. 每个问题都必须能仅凭该片段回答；2. 语气自然、口语化，可以用同义词或简称，但不要照抄原文措辞；"
    "3. 5 个问题覆盖片段的不同侧面（定义、方法、数值、结论等）；4. 只输出 JSON："
    '{"questions": ["问题1", "问题2", "问题3", "问题4", "问题5"]}'
)

_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(
            api_key=Config.DEEPSEEK_API_KEY,
            base_url=Config.DEEPSEEK_BASE_URL,
            timeout=60,
            max_retries=1,
        )
    return _client


def qa_collection_name_for(user_id: str) -> str:
    return f"_{user_id}_qa_{QA_SCHEMA_VERSION}"


def _parse_questions(raw: str) -> list[str]:
    text = (raw or "").strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\[[\s\S]*\]", text)
        if not match:
            return []
        data = json.loads(match.group(0))
    if isinstance(data, dict):
        data = data.get("questions", [])
    if not isinstance(data, list):
        return []
    return [
        q.strip()[:MAX_QUESTION_CHARS]
        for q in data
        if isinstance(q, str) and len(q.strip()) >= 4
    ][:6]


async def _gen_questions(text: str, doc_title: str, sem: asyncio.Semaphore) -> list[str]:
    user = f"【文档：{doc_title}】\n片段内容：\n{text[:MAX_CHUNK_CHARS_FOR_PROMPT]}"
    async with sem:
        for attempt in range(3):
            try:
                response = await _get_client().chat.completions.create(
                    model=Config.DEEPSEEK_MODEL,
                    messages=[
                        {"role": "system", "content": _SYSTEM_PROMPT},
                        {"role": "user", "content": user},
                    ],
                    temperature=0.7,
                    max_tokens=500,
                    response_format={"type": "json_object"},
                    extra_body={"thinking": {"type": "disabled"}},
                )
                raw = response.choices[0].message.content if response.choices else ""
                questions = _parse_questions(raw or "")
                # 去重保序
                return list(dict.fromkeys(questions))[:6]
            except Exception as exc:
                if attempt == 2:
                    logger.warning("QA 问题生成失败（%s）: %s", doc_title, exc)
                    return []
                await asyncio.sleep(2 ** attempt)
    return []


def _ensure_collection(client: MilvusClient, name: str) -> None:
    dim = Config.QWEN_EMBEDDING_DIMENSIONS
    if client.has_collection(collection_name=name):
        desc = client.describe_collection(collection_name=name)
        for field in desc.get("fields", []):
            if field.get("name") == "qVector":
                current = (field.get("params") or {}).get("dim")
                if current is not None and int(current) != dim:
                    print(f"QA 集合 {name} 维度 {current} → {dim}，删除重建")
                    client.drop_collection(collection_name=name)
                break
        if client.has_collection(collection_name=name):
            return

    schema = client.create_schema(auto_id=False, enable_dynamic_field=False)
    schema.add_field("id", DataType.INT64, is_primary=True)
    schema.add_field("docId", DataType.VARCHAR, max_length=100)
    schema.add_field("docTitle", DataType.VARCHAR, max_length=500)
    schema.add_field("chunkKey", DataType.VARCHAR, max_length=200)
    schema.add_field("questionId", DataType.VARCHAR, max_length=250)
    schema.add_field("question", DataType.VARCHAR, max_length=1000)
    schema.add_field("qVector", DataType.FLOAT_VECTOR, dim=dim)

    index_params = client.prepare_index_params()
    index_params.add_index(
        field_name="qVector",
        index_type="IVF_FLAT",
        metric_type="COSINE",
        params={"nlist": 128},
    )
    client.create_collection(collection_name=name, schema=schema, index_params=index_params)
    client.load_collection(collection_name=name)


def insert_questions(rows: list[dict], vectors: list[list[float]], user_id: str) -> int:
    """写入问题向量（调用方已算好向量）：Milvus 同步 SDK，须在线程池中运行。"""
    if not rows:
        return 0
    client = get_milvus()
    name = qa_collection_name_for(user_id)
    _ensure_collection(client, name)

    now_ms = int(time.time() * 1000)
    data = [
        {
            "id": now_ms * 100000 + index * 1000 + random.randint(0, 999),
            **row,
            "qVector": vectors[index],
        }
        for index, row in enumerate(rows)
    ]
    client.insert(collection_name=name, data=data)
    client.flush(collection_name=name)
    return len(data)


def search_questions(query_vector: list[float], user_id: str, limit: int = 10) -> list[dict]:
    """问题级检索 → 按 chunkKey 去重保序，返回 chunk 级候选。"""
    client = get_milvus()
    name = qa_collection_name_for(user_id)
    if not client.has_collection(collection_name=name):
        return []

    results = client.search(
        collection_name=name,
        data=[query_vector],
        anns_field="qVector",
        search_params={"metric_type": "COSINE", "params": {"nprobe": 10}},
        limit=max(limit * 3, 20),
        output_fields=["chunkKey", "question"],
    )
    merged: dict[str, dict] = {}
    order: list[str] = []
    for hits in results:
        for hit in hits:
            entity = hit.get("entity") or {}
            chunk_key = entity.get("chunkKey")
            if not chunk_key or chunk_key in merged:
                continue
            merged[chunk_key] = {
                "chunkKey": chunk_key,
                "question": entity.get("question") or "",
                "score": hit.get("distance", 0),
            }
            order.append(chunk_key)
            if len(order) >= limit:
                break
    return [merged[key] for key in order]


def delete_by_doc_id(doc_id: str, user_id: str) -> None:
    client = get_milvus()
    name = qa_collection_name_for(user_id)
    if not client.has_collection(collection_name=name):
        return
    client.delete(collection_name=name, filter=f'docId == "{doc_id}"')


async def build_index(doc_id: str, doc_title: str, chunks: list, user_id: str) -> int:
    """为整篇文档生成 QA 索引：问题生成 → 批量向量化 → 写 Milvus。

    chunks 是 structure.ChunkSpan 列表；只有正文非空的 chunk 参与。
    """
    valid = [c for c in chunks if c.text.strip()]
    if not valid:
        return 0

    sem = asyncio.Semaphore(LLM_CONCURRENCY)
    done = 0

    async def _one(chunk):
        nonlocal done
        questions = await _gen_questions(chunk.text, doc_title, sem)
        done += 1
        if done % 20 == 0 or done == len(valid):
            print(f"  QA 问题生成 {done}/{len(valid)}（{doc_title[:30]}）", flush=True)
        return questions

    groups = await asyncio.gather(*(_one(c) for c in valid))

    rows: list[dict] = []
    for chunk, questions in zip(valid, groups):
        chunk_key = f"{doc_id}#{chunk.chunk_index}"
        for i, question in enumerate(questions[:QUESTIONS_PER_CHUNK]):
            rows.append(
                {
                    "docId": doc_id,
                    "docTitle": doc_title,
                    "chunkKey": chunk_key,
                    "questionId": f"{chunk_key}#q{i}",
                    "question": question,
                }
            )
    if not rows:
        return 0

    print(f"  QA 向量化 {len(rows)} 条并写入 Milvus ...", flush=True)
    vectors = await embedding_client.embed_documents([row["question"] for row in rows])
    await asyncio.to_thread(insert_questions, rows, vectors, user_id)
    return len(rows)
