"""模型调用封装：文本对话 / 多模态图片理解 / 图片编码。

对话与视觉统一走 DeepSeek（deepseek-flash 自带多模态），embedding 仍走通义
（见 file_management/embeddings.py）。
"""
from typing import cast

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam

from ..core.config import Config
from ..file_management.image_storage import assert_image_signature, resolve_stored_image_path
from .prompts import TOOLS_DATA, build_system_prompt

_llm_client_singleton: AsyncOpenAI | None = None


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


def _strip_message(message: dict) -> dict:
    return {"role": message["role"], "content": message["content"]}


async def calling_model(
    messages_list: list[dict],
    is_knowledge_based: bool = False,
    with_kb_rules: bool = False,
):
    """调用文本模型（DeepSeek）。注意：thinking 模式不支持强制 tool_choice，
    意图识别需要强制调用工具，因此必须显式关闭 thinking。"""
    kwargs: dict = {
        "model": Config.DEEPSEEK_MODEL,
        "messages": [
            {"role": "system", "content": build_system_prompt(with_kb_rules)},
            *[_strip_message(m) for m in messages_list],
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


async def encode_image(image_path: str, mimetype: str) -> dict:
    """将服务端已校验的图片转换为 base64，交给多模态大模型。"""
    absolute_path = resolve_stored_image_path(image_path)
    assert_image_signature(absolute_path, mimetype)
    import base64

    base64_image = base64.b64encode(absolute_path.read_bytes()).decode()
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{mimetype};base64,{base64_image}"},
    }


async def model_vl_res(message_list: list[dict], image_url_obj: dict):
    """调用多模态大模型，理解图片（deepseek-flash 自带视觉能力）。"""
    last_user_message = message_list[-1]
    messages = cast(
        "list[ChatCompletionMessageParam]",
        [
            {
                "role": "system",
                "content": (
                    f"{build_system_prompt()}\n\n图片理解要求：先客观描述图片中的关键信息，"
                    "再结合用户问题进行分析；涉及图表时提取趋势、对比、异常点和可读出的数据；"
                    "无法从图片确认的内容要明确说明，不要臆造。"
                ),
            },
            {
                "role": "user",
                "content": [
                    image_url_obj,
                    {"type": "text", "text": last_user_message["content"]},
                ],
            },
        ],
    )
    return await _llm_client().chat.completions.create(
        model=Config.DEEPSEEK_MODEL,
        messages=messages,
        stream=True,
        extra_body={"thinking": {"type": "disabled"}},
    )
