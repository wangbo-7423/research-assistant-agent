"""模型调用封装：文本对话 + 原生多模态消息组装。

对话与视觉统一走 DeepSeek（deepseek-flash 自带多模态）：图片不再单独调用视觉模型，
而是把消息里的 `uploadImageList`（历史单对象 / 新数组两种结构）展开成 OpenAI 多模态
content parts，和文字一起送进同一轮对话。embedding 仍走通义（见 file_management/embeddings.py）。
"""
import base64
import logging
from typing import Any

from openai import AsyncOpenAI

from ..core.config import Config
from ..file_management.image_storage import (
    ALLOWED_IMAGE_TYPES,
    assert_image_signature,
    resolve_stored_image_path,
)
from .prompts import TOOLS_DATA, build_system_prompt

logger = logging.getLogger(__name__)

# 多模态上下文控制：只展开最近 3 条带图消息，且总图片数不超过 6 张，
# 避免长会话每轮都把历史图片重新编码、把上下文挤爆。
_IMAGE_HISTORY_MESSAGES = 3
_IMAGE_HISTORY_LIMIT = 6
_IMAGE_CACHE_MAX = 16

_llm_client_singleton: AsyncOpenAI | None = None
# 按 (绝对路径, mtime, size) 缓存 data URL，图片没变就不重复读盘 + base64
_image_data_url_cache: dict[tuple[str, int, int], str] = {}


def _llm_client() -> AsyncOpenAI:
    global _llm_client_singleton
    if _llm_client_singleton is None:
        _llm_client_singleton = AsyncOpenAI(
            api_key=Config.DEEPSEEK_API_KEY,
            base_url=Config.DEEPSEEK_BASE_URL,
            timeout=60,
            max_retries=2,
        )
    return _llm_client_singleton


def _stored_image_data_url(image_path: str, mimetype: str) -> str | None:
    """服务端已落盘的图片 → data URL；路径非法、文件缺失或类型不符时返回 None。"""
    try:
        absolute_path = resolve_stored_image_path(image_path)
        stat = absolute_path.stat()
    except Exception:
        logger.warning("图片不存在或路径非法，已跳过: %s", image_path)
        return None

    cache_key = (str(absolute_path), stat.st_mtime_ns, stat.st_size)
    cached = _image_data_url_cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        assert_image_signature(absolute_path, mimetype)
        encoded = base64.b64encode(absolute_path.read_bytes()).decode()
    except Exception:
        logger.warning("图片校验失败，已跳过: %s", image_path)
        return None

    data_url = f"data:{mimetype};base64,{encoded}"
    if len(_image_data_url_cache) >= _IMAGE_CACHE_MAX:
        _image_data_url_cache.pop(next(iter(_image_data_url_cache)))
    _image_data_url_cache[cache_key] = data_url
    return data_url


def _message_images(message: dict) -> list[dict[str, Any]]:
    """取出消息携带的图片：兼容历史单对象与新数组两种结构。"""
    raw = message.get("uploadImageList")
    if not raw:
        return []
    items = raw if isinstance(raw, list) else [raw]
    result: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        image_path = item.get("imagePath")
        mimetype = str(item.get("mimetype") or "").lower()
        if image_path and mimetype in ALLOWED_IMAGE_TYPES:
            result.append(item)
    return result


def _collect_images(messages_list: list[dict]) -> dict[int, list[dict[str, Any]]]:
    """挑出要送进模型的历史图片：最近 3 条带图用户消息、总量 ≤6 张。"""
    indexes = [
        index
        for index, message in enumerate(messages_list)
        if message.get("role") == "user" and _message_images(message)
    ][-_IMAGE_HISTORY_MESSAGES:]
    budget = _IMAGE_HISTORY_LIMIT
    selected: dict[int, list[dict[str, Any]]] = {}
    for index in indexes:
        if budget <= 0:
            break
        images = _message_images(messages_list[index])[:budget]
        if images:
            selected[index] = images
            budget -= len(images)
    return selected


def _build_model_message(message: dict, images: list[dict[str, Any]]) -> dict:
    """组装单条消息：带图时 content 变成 [{type:text}, {type:image_url}, ...]。"""
    content = message.get("content") or ""
    if not images:
        return {"role": message["role"], "content": content}

    parts: list[dict[str, Any]] = []
    if content:
        parts.append({"type": "text", "text": content})
    for image in images:
        data_url = _stored_image_data_url(image["imagePath"], str(image["mimetype"]).lower())
        if data_url:
            parts.append({"type": "image_url", "image_url": {"url": data_url}})
    if not parts:
        return {"role": message["role"], "content": content}
    if all(part["type"] == "image_url" for part in parts):
        # 允许「只发图不写文字」：补一句默认提问，保证消息结构对模型友好
        parts.insert(0, {"type": "text", "text": "请识别并分析这些图片"})
    return {"role": message["role"], "content": parts}


async def calling_model(
    messages_list: list[dict],
    is_knowledge_based: bool = False,
    with_kb_rules: bool = False,
):
    """调用文本/多模态模型（DeepSeek）。注意：thinking 模式不支持强制 tool_choice，
    意图识别需要强制调用工具，因此必须显式关闭 thinking。"""
    images_by_index = _collect_images(messages_list)
    kwargs: dict = {
        "model": Config.DEEPSEEK_MODEL,
        "messages": [
            {
                "role": "system",
                "content": build_system_prompt(with_kb_rules, bool(images_by_index)),
            },
            *[
                _build_model_message(message, images_by_index.get(index, []))
                for index, message in enumerate(messages_list)
            ],
        ],
        "stream": True,
        "tools": TOOLS_DATA,
        "tool_choice": (
            {"type": "function", "function": {"name": "clarify_intent"}}
            if is_knowledge_based
            else "none"
        ),
        "extra_body": {"thinking": {"type": "disabled"}},
    }
    return await _llm_client().chat.completions.create(**kwargs)
