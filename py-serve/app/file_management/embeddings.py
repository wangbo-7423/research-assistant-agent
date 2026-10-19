"""通义千问 embedding 客户端：批量向量化（每批 10 条）+ 查询向量缓存。"""
import threading
from collections import OrderedDict

from openai import AsyncOpenAI

from ..core.config import Config
from ..core.response import BizError


class EmbeddingClient:
    def __init__(self):
        self.client = AsyncOpenAI(
            api_key=Config.QWEN_API_KEY,
            base_url=Config.QWEN_BASE_URL,
            timeout=60,
            max_retries=2,
        )
        self.model = Config.QWEN_EMBEDDING_MODEL
        self.dimensions = Config.QWEN_EMBEDDING_DIMENSIONS
        self.batch_size = Config.EMBED_BATCH_SIZE
        self._cache: OrderedDict[str, list[float]] = OrderedDict()
        self._cache_max = 500
        self._lock = threading.Lock()

    async def embed_query(self, text: str) -> list[float]:
        cache_key = f"{self.model}:{self.dimensions}:{text}"
        with self._lock:
            cached = self._cache.get(cache_key)
        if cached:
            return cached
        try:
            response = await self.client.embeddings.create(
                model=self.model,
                input=text,
                encoding_format="float",
                dimensions=self.dimensions,
            )
        except Exception as e:
            raise BizError(f"生成查询向量失败: {e}", 400)
        if not response.data:
            raise BizError("生成查询向量失败: OpenAI API 返回数据为空", 400)
        vector = response.data[0].embedding
        with self._lock:
            if len(self._cache) >= self._cache_max:
                self._cache.clear()  # FIFO 淘汰：评测场景缓存集中在同一批 query，全清可接受
            self._cache[cache_key] = vector
        return vector

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        all_vectors: list[list[float]] = []
        for start in range(0, len(texts), self.batch_size):
            batch = texts[start : start + self.batch_size]
            batch_no = start // self.batch_size + 1
            total_batches = (len(texts) + self.batch_size - 1) // self.batch_size
            print(f"处理批次 {batch_no}/{total_batches}, 数量: {len(batch)}")
            response = await self.client.embeddings.create(
                model=self.model,
                input=batch,
                encoding_format="float",
                dimensions=self.dimensions,
            )
            if not response.data:
                raise BizError(f"批次 {batch_no} API 返回数据为空", 400)
            sorted_data = sorted(response.data, key=lambda item: item.index)
            batch_vectors = [item.embedding for item in sorted_data]
            # 阿里 API 可能跳过空文本导致返回数量不足，降级为逐条生成补齐
            if len(batch_vectors) != len(batch):
                print(
                    f"批次 {batch_no} 返回数量不符: 期望 {len(batch)}, 实际 {len(batch_vectors)}，降级为逐条生成"
                )
                batch_vectors = []
                for text in batch:
                    single = await self.client.embeddings.create(
                        model=self.model,
                        # 空文本用占位符替代，避免 API 拒绝
                        input=text if text.strip() else " ",
                        encoding_format="float",
                        dimensions=self.dimensions,
                    )
                    if not single.data:
                        raise BizError("逐条生成向量时 API 返回数据为空", 400)
                    batch_vectors.append(single.data[0].embedding)
            all_vectors.extend(batch_vectors)
        if len(all_vectors) != len(texts):
            raise BizError(f"向量数量({len(all_vectors)})与文本数量({len(texts)})不一致", 400)
        return all_vectors


embedding_client = EmbeddingClient()
