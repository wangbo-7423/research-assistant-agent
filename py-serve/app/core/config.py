"""环境配置：与 NestJS 版 .env 字段保持一致。"""
import os
from pathlib import Path

from dotenv import load_dotenv

# .env 位于 py-serve 根目录（本文件在 app/core/，需上溯三级）
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")


def _get(key: str, default: str = "") -> str:
    value = os.getenv(key)
    return value if value not in (None, "") else default


class Config:
    MONGODB_URI: str = _get("MONGODB_URI", "mongodb://127.0.0.1:27017/nest_serve_db")
    PASSWORD_KEY: str = _get("PASSWORD_KEY", "absdefg")
    JWT_SECRET: str = _get("JWT_SECRET", "12345hsgabvd")
    JWT_EXPIRE_DAYS: int = 10

    MILVUS_ADDRESS: str = _get("MILVUS_ADDRESS", "127.0.0.1:19530")

    QWEN_API_KEY: str = _get("QWEN_API_KEY")
    QWEN_BASE_URL: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    QWEN_EMBEDDING_MODEL: str = _get("QWEN_EMBEDDING_MODEL", "text-embedding-v3")
    # 通义千问 text-embedding-v3 仅支持 [64, 128, 256, 512, 768, 1024]，默认 1024
    # 注意：此值必须与 Milvus 集合中 docVector 字段的 dim 保持一致
    QWEN_EMBEDDING_DIMENSIONS: int = int(_get("QWEN_EMBEDDING_DIMENSIONS", "1024"))

    # 对话/视觉/关键词提取统一走 DeepSeek（deepseek-flash 自带多模态）
    DEEPSEEK_API_KEY: str = _get("DEEPSEEK_API_KEY")
    DEEPSEEK_BASE_URL: str = _get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    DEEPSEEK_MODEL: str = _get("DEEPSEEK_MODEL", "deepseek-flash")

    REDIS_HOST: str = _get("REDIS_HOST", "127.0.0.1")
    REDIS_PORT: int = int(_get("REDIS_PORT", "6379"))

    IMAGE_BASE_URL_LOCAL: str = _get("IMAGE_BASE_URL_local", "http://localhost:3000/open-image")
    PORT: int = int(_get("PORT", "3000"))

    # 检索常量（与 NestJS 版一致）
    EMBED_BATCH_SIZE: int = 10  # 通义千问 API 限制每批最多 10 个
    RRF_K: int = 60
    VECTOR_WEIGHT: float = 0.7
    KEYWORD_WEIGHT: float = 0.3


if not Config.QWEN_API_KEY:
    raise RuntimeError("QWEN_API_KEY 未在环境变量中配置（embedding 向量化必需）")
if not Config.DEEPSEEK_API_KEY:
    raise RuntimeError("DEEPSEEK_API_KEY 未在环境变量中配置（对话/视觉/关键词提取必需）")
