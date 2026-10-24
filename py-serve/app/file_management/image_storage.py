"""图片存储的安全工具（对应 NestJS image-storage.ts）。

两类入口：
  1. 粘贴图片内联落盘：`save_inline_images`（base64 → 校验 → 写 uploads-image/）
  2. 历史消息按路径读取：`resolve_stored_image_path` + `assert_image_signature`

文件名一律由服务端生成，且固定为 `uploads-image/` 的扁平子文件，
这样 `/open-image` 静态目录与路径防护（父目录必须等于 UPLOAD_ROOT）能同时成立。
"""
import base64
import binascii
import hashlib
import logging
import re
import uuid
from pathlib import Path

from ..core.config import Config
from ..core.response import BizError

logger = logging.getLogger(__name__)

IMAGE_UPLOAD_DIR = "uploads-image"
IMAGE_PUBLIC_ROUTE = "/open-image"

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}
IMAGE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}

MAX_IMAGE_SIZE = 10 * 1024 * 1024  # 单张解码后上限 10MB
MAX_INLINE_IMAGES = 4  # 单条消息最多携带 4 张图
MAX_INLINE_IMAGE_BYTES = 24 * 1024 * 1024  # 单请求解码后的图片总量上限
INLINE_IMAGE_PREFIX = "paste-"

UPLOAD_ROOT = Path(__file__).resolve().parent.parent.parent / IMAGE_UPLOAD_DIR


def ensure_image_upload_dir() -> Path:
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    return UPLOAD_ROOT


def assert_image_bytes(data: bytes, mimetype: str) -> None:
    """校验文件魔数，避免仅修改 Content-Type 后提交伪图片。

    落盘前用 bytes 校验，落盘后的历史图片再用 `assert_image_signature` 读文件头。
    """
    header = data[:12]
    is_jpeg = len(header) >= 3 and header[0] == 0xFF and header[1] == 0xD8 and header[2] == 0xFF
    is_png = (
        len(header) >= 8
        and header[0] == 0x89
        and header[1] == 0x50
        and header[2] == 0x4E
        and header[3] == 0x47
        and header[4] == 0x0D
        and header[5] == 0x0A
        and header[6] == 0x1A
        and header[7] == 0x0A
    )
    is_webp = len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP"
    valid = (mimetype in ("image/jpeg", "image/jpg") and is_jpeg) or (
        mimetype == "image/png" and is_png
    ) or (mimetype == "image/webp" and is_webp)
    if not valid:
        raise BizError("文件内容与声明的图片类型不一致", 400)


def assert_image_signature(absolute_path: Path, mimetype: str) -> None:
    """按文件头校验已落盘图片的真实类型。"""
    assert_image_bytes(absolute_path.read_bytes()[:12], mimetype)


def build_public_image_url(filename: str) -> str:
    """拼出前端可直接访问的图片地址（静态目录 /open-image）。"""
    base = (Config.IMAGE_BASE_URL_LOCAL or "").rstrip("/")
    if not base.endswith(IMAGE_PUBLIC_ROUTE):
        base = f"{base}{IMAGE_PUBLIC_ROUTE}"
    return f"{base}/{filename}"


def _decode_inline_image(image: dict, index: int) -> tuple[bytes, str, str]:
    """解码并校验单张图片，返回 (原始字节, mimetype, 展示用文件名)。"""
    mimetype = str(image.get("mimetype") or "").lower()
    if mimetype not in ALLOWED_IMAGE_TYPES:
        raise BizError(f"不支持的图片类型: {mimetype or '未知'}", 400)

    raw = str(image.get("data") or "")
    if not raw.strip():
        raise BizError("图片内容不能为空", 400)
    # 兼容前端可能残留的 data URL 前缀与 base64 换行
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    try:
        data = base64.b64decode(re.sub(r"\s+", "", raw), validate=True)
    except (binascii.Error, ValueError) as error:
        logger.warning("第 %s 张图片 base64 解码失败: %s", index, error)
        raise BizError("图片数据解析失败，请重新粘贴", 400) from error

    if not data:
        raise BizError("图片内容不能为空", 400)
    if len(data) > MAX_IMAGE_SIZE:
        raise BizError("单张图片大小不能超过 10MB", 400)
    assert_image_bytes(data, mimetype)
    return data, mimetype, str(image.get("fileName") or "image")


def save_inline_images(images: list[dict]) -> list[dict]:
    """把随消息提交的 base64 图片落盘，返回可直接入库/回显的图片引用。

    数据库里只保留 imagePath / imageUrl，绝不保存 base64，避免会话文档膨胀。
    先整体校验再统一写盘：中途有非法图片时不会留下半批孤儿文件。
    """
    if len(images) > MAX_INLINE_IMAGES:
        raise BizError(f"最多一次携带 {MAX_INLINE_IMAGES} 张图片", 400)

    decoded: list[tuple[bytes, str, str]] = []
    total_bytes = 0
    for index, image in enumerate(images, 1):
        data, mimetype, file_name = _decode_inline_image(image, index)
        total_bytes += len(data)
        if total_bytes > MAX_INLINE_IMAGE_BYTES:
            raise BizError("本次发送的图片总量过大，请减少图片数量或尺寸", 400)
        decoded.append((data, mimetype, file_name))

    ensure_image_upload_dir()
    saved: list[dict] = []
    try:
        for data, mimetype, file_name in decoded:
            digest = hashlib.sha1(data).hexdigest()[:16]
            filename = f"{INLINE_IMAGE_PREFIX}{digest}-{uuid.uuid4().hex[:8]}{IMAGE_EXTENSIONS[mimetype]}"
            (UPLOAD_ROOT / filename).write_bytes(data)
            saved.append(
                {
                    "imagePath": f"{IMAGE_UPLOAD_DIR}/{filename}",
                    "imageUrl": build_public_image_url(filename),
                    "mimetype": mimetype,
                    "fileName": file_name,
                    "fileSize": len(data),
                }
            )
    except Exception:
        # 写盘失败（磁盘/权限）时回滚已写入的文件，避免孤儿图片
        delete_session_image_files([item["imagePath"] for item in saved])
        raise

    logger.info("已保存 %s 张内联图片，共 %.1fKB", len(saved), total_bytes / 1024)
    return saved


def delete_session_image_files(image_paths: list[str]) -> int:
    """删除会话引用的图片文件（仅限 uploads-image 直接子文件），返回删除数量。"""
    removed = 0
    for image_path in dict.fromkeys(path for path in image_paths if path):
        try:
            resolve_stored_image_path(image_path).unlink(missing_ok=True)
            removed += 1
        except Exception:
            logger.warning("会话图片清理失败: %s", image_path)
    if removed:
        logger.info("会话图片已清理 %s 个", removed)
    return removed


def resolve_stored_image_path(image_path: str) -> Path:
    """只允许访问 uploads-image 目录的直接子文件，阻止任意路径读写。"""
    if not image_path:
        raise BizError("图片路径不能为空", 400)
    normalized = image_path.strip().replace("\\", "/")
    if not normalized or "\x00" in normalized:
        raise BizError("图片路径不合法", 400)
    resolved = (UPLOAD_ROOT.parent / normalized).resolve()
    if resolved.parent != UPLOAD_ROOT.resolve():
        raise BizError("图片路径必须位于图片上传目录内", 400)
    return resolved
