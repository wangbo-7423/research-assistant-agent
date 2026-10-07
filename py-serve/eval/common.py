"""召回评测公共设施：embedding、DeepSeek 调用、RRF（与生产 service.py 对齐）。"""
import asyncio
import json
import re
from pathlib import Path

import numpy as np
from openai import AsyncOpenAI

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import Config  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent / "data"

_qwen: AsyncOpenAI | None = None
_ds: AsyncOpenAI | None = None


def qwen_client() -> AsyncOpenAI:
    global _qwen
    if _qwen is None:
        _qwen = AsyncOpenAI(api_key=Config.QWEN_API_KEY, base_url=Config.QWEN_BASE_URL, timeout=60, max_retries=2)
    return _qwen


def ds_client() -> AsyncOpenAI:
    global _ds
    if _ds is None:
        _ds = AsyncOpenAI(api_key=Config.DEEPSEEK_API_KEY, base_url=Config.DEEPSEEK_BASE_URL, timeout=120, max_retries=2)
    return _ds


async def embed_texts(texts: list[str], batch_size: int = 10) -> np.ndarray:
    """批量向量化（通义限制每批 10 条），顺序与输入一致。"""
    vecs: list[list[float] | None] = [None] * len(texts)
    sem = asyncio.Semaphore(4)

    async def run_batch(start: int):
        batch = texts[start : start + batch_size]
        async with sem:
            for attempt in range(3):
                try:
                    resp = await qwen_client().embeddings.create(
                        model=Config.QWEN_EMBEDDING_MODEL,
                        input=batch,
                        encoding_format="float",
                        dimensions=Config.QWEN_EMBEDDING_DIMENSIONS,
                    )
                    for i, d in enumerate(resp.data):
                        vecs[start + i] = d.embedding
                    return
                except Exception as e:
                    if attempt == 2:
                        raise
                    print(f"embedding 批次 {start} 重试: {e}")
                    await asyncio.sleep(2 ** attempt * 2)

    await asyncio.gather(*(run_batch(i) for i in range(0, len(texts), batch_size)))
    return np.array(vecs, dtype=np.float32)


async def ds_chat(model: str, system: str, user: str, temperature: float, sem: asyncio.Semaphore) -> str:
    """DeepSeek JSON 输出调用，返回原始 content。"""
    async with sem:
        for attempt in range(3):
            try:
                resp = await ds_client().chat.completions.create(
                    model=model,
                    messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                    temperature=temperature,
                    response_format={"type": "json_object"},
                    extra_body={"thinking": {"type": "disabled"}},
                )
                return resp.choices[0].message.content or ""
            except Exception as e:
                if attempt == 2:
                    raise
                print(f"DeepSeek 调用重试: {e}")
                await asyncio.sleep(2 ** attempt * 2)
    return ""


def parse_json_object(raw: str) -> dict:
    raw = (raw or "").strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", raw)
        if match:
            return json.loads(match.group(0))
        raise


def rrf_fuse(rankings: list[list[str]], weights: list[float], k: int = 60) -> list[str]:
    """生产同款 RRF：score = Σ weight/(k+rank+1)，rank 从 0 开始，输入为 id 列表。"""
    scores: dict[str, float] = {}
    for ranking, weight in zip(rankings, weights):
        for rank, item_id in enumerate(ranking):
            scores[item_id] = scores.get(item_id, 0.0) + weight / (k + rank + 1)
    return [item_id for item_id, _ in sorted(scores.items(), key=lambda x: -x[1])]


def save_json(name: str, obj) -> Path:
    DATA_DIR.mkdir(exist_ok=True)
    path = DATA_DIR / name
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"saved {path}")
    return path


def load_json(name: str):
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))
