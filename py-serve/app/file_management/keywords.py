"""检索关键词提取：优先 DeepSeek LLM 语义提取（学术同义词/术语归一），
LLM 不可用或失败时降级为本地规则提取，保证检索链路不中断。
"""
import json
import re

from openai import AsyncOpenAI

from ..core.config import Config

_STOP_WORDS = {
    "的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一", "一个",
    "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好",
    "什么", "怎么", "哪些", "如何", "吗", "呢", "吧", "啊", "请问", "一下", "可以",
    "the", "a", "an", "is", "are", "of", "to", "and", "or", "what", "how", "which",
}

_LLM_SYSTEM_PROMPT = (
    "你是科研资料知识库检索的关键词提取器。从用户问题中提取 3~8 个最适合用于在论文、报告等科研文档中做关键词匹配的词或短语。"
    "要求：1. 保留方法名、模型名、数据集名、指标名、概念术语等学术实体；2. 口语表达归一为规范学术术语（如\"rag检索\"→\"检索增强生成\"）；"
    "3. 去除疑问词、语气词和停用词；4. 只输出 JSON 数组字符串，如 [\"Transformer\",\"自注意力机制\"]，不要输出任何其他内容。"
)

_deepseek_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI | None:
    global _deepseek_client
    if not Config.DEEPSEEK_API_KEY:
        return None
    if _deepseek_client is None:
        _deepseek_client = AsyncOpenAI(
            api_key=Config.DEEPSEEK_API_KEY,
            base_url=Config.DEEPSEEK_BASE_URL,
            timeout=30,
            max_retries=1,
        )
    return _deepseek_client


async def extract_keywords_by_llm(query: str) -> list[str]:
    client = _get_client()
    if client is None:
        raise RuntimeError("DeepSeek 未配置")
    response = await client.chat.completions.create(
        model=Config.DEEPSEEK_MODEL,
        messages=[
            {"role": "system", "content": _LLM_SYSTEM_PROMPT},
            {"role": "user", "content": query},
        ],
        temperature=0,
        max_tokens=200,
        response_format={"type": "json_object"},
        extra_body={"thinking": {"type": "disabled"}},  # 关键词提取无需推理，关闭以降低延迟
    )
    raw = (response.choices[0].message.content or "").strip() if response.choices else ""
    parsed = None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        # 从返回文本中截取第一个 JSON 数组
        match = re.search(r"\[[\s\S]*\]", raw)
        if not match:
            return []
        parsed = json.loads(match.group(0))
    if isinstance(parsed, dict) and isinstance(parsed.get("keywords"), list):
        parsed = parsed["keywords"]
    if not isinstance(parsed, list):
        return []
    return [
        k.strip()
        for k in parsed
        if isinstance(k, str) and len(k.strip()) >= 2
    ][:8]


def extract_keywords_by_rule(query: str) -> list[str]:
    """规则提取（降级方案）：中英文混合，去停用词，中文 2~4 字滑窗。"""
    candidates: list[str] = []
    en_words = re.findall(r"[a-z0-9]{2,}", query.lower())
    candidates.extend(en_words)
    zh_text = re.sub(r"[a-z0-9\s\W]", "", query, flags=re.IGNORECASE | re.UNICODE)
    for size in (4, 3, 2):
        for i in range(0, len(zh_text) - size + 1):
            candidates.append(zh_text[i : i + size])
    seen: set[str] = set()
    result: list[str] = []
    for k in candidates:
        k = k.strip()
        if not k or k in _STOP_WORDS or k in seen:
            continue
        seen.add(k)
        result.append(k)
        if len(result) >= 20:  # 最多 20 个关键词，避免 filter 过长
            break
    return result


async def extract_keywords(query: str) -> list[str]:
    client = _get_client()
    if client is not None:
        try:
            keywords = await extract_keywords_by_llm(query)
            if keywords:
                return keywords
        except Exception as e:
            print(f"DeepSeek 关键词提取失败，降级为规则提取: {e}")
    return extract_keywords_by_rule(query)
