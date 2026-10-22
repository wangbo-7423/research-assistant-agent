"""环境配置：与 NestJS 版 .env 字段保持一致。"""
import os
from pathlib import Path

from dotenv import load_dotenv

# .env 位于 py-serve 根目录（本文件在 app/core/，需上溯三级）
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")


def _get(key: str, default: str = "") -> str:
    value = os.getenv(key)
    return value if value not in (None, "") else default


# 这两个值曾经作为源码里的默认值公开在仓库里，用它们签名等同于没有密钥：
#   - JWT_SECRET 换成随机串只会让已签发的 token 失效（用户重新登录即可），所以直接拒绝启动；
#   - PASSWORD_KEY 换成随机串会让库存的密码散列全部失效（老用户无法登录），
#     影响面取决于已注册账号数量，因此这里只告警不阻断，由使用者择机轮换。
_PUBLIC_JWT_DEFAULT = "12345hsgabvd"
_PUBLIC_PASSWORD_DEFAULT = "absdefg"


class Config:
    MONGODB_URI: str = _get("MONGODB_URI", "mongodb://127.0.0.1:27017/nest_serve_db")
    # 不再提供默认值：缺失即启动失败，避免"用公开字符串签名"这种静默降级
    PASSWORD_KEY: str = _get("PASSWORD_KEY")
    JWT_SECRET: str = _get("JWT_SECRET")
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
    # 有 QA 索引时：chunk 向量 + QA 问题路双路 RRF（离线实验 0.5/0.5 最优）
    CHUNK_WEIGHT: float = 0.5
    QA_WEIGHT: float = 0.5


if not Config.QWEN_API_KEY:
    raise RuntimeError("QWEN_API_KEY 未在环境变量中配置（embedding 向量化必需）")
if not Config.DEEPSEEK_API_KEY:
    raise RuntimeError("DEEPSEEK_API_KEY 未在环境变量中配置（对话/视觉/关键词提取必需）")

if not Config.JWT_SECRET:
    raise RuntimeError("JWT_SECRET 未在环境变量中配置（缺失将无法验签，任何 token 都会失效）")
if Config.JWT_SECRET == _PUBLIC_JWT_DEFAULT:
    raise RuntimeError(
        "JWT_SECRET 仍是源码历史默认值，等同于公开密钥，任何人都能伪造 token；"
        + "请换成一个随机串（例如 python -c \"import secrets;print(secrets.token_urlsafe(48))\"）"
    )
if not Config.PASSWORD_KEY:
    raise RuntimeError("PASSWORD_KEY 未在环境变量中配置（密码散列与登录校验依赖它）")
if Config.PASSWORD_KEY == _PUBLIC_PASSWORD_DEFAULT:
    print(
        "警告：PASSWORD_KEY 仍是源码历史默认值，库存密码散列可被离线破解。"
        + "轮换请自行安排——换新值会让所有已有账号无法登录（散列无法用它重新计算）。"
    )
