"""图片上传/删除的安全工具（对应 NestJS image-storage.ts）。"""
import os
import random
import re
import time
from pathlib import Path

from ..response import BizError

IMAGE_UPLOAD_DIR = "uploads-image"
IMAGE_PUBLIC_ROUTE = "/open-image"

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}
IMAGE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}

UPLOAD_ROOT = Path(__file__).resolve().parent.parent.parent / IMAGE_UPLOAD_DIR


def ensure_image_upload_dir() -> Path:
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    return UPLOAD_ROOT


def create_stored_image_filename(fieldname: str, mimetype: str) -> str:
    extension = IMAGE_EXTENSIONS.get(mimetype)
    if not extension:
        raise BizError(f"不支持的图片类型: {mimetype}", 400)
    safe_fieldname = re.sub(r"[^a-zA-Z0-9_-]", "", fieldname) or "image"
    unique_suffix = f"{int(time.time() * 1000)}-{random.randint(0, 10**9)}"
    return f"{safe_fieldname}-{unique_suffix}{extension}"


def assert_image_signature(absolute_path: Path, mimetype: str) -> None:
    """校验文件魔数，避免仅修改 Content-Type 后上传伪图片。"""
    header = absolute_path.read_bytes()[:12]
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


def delete_image_file(image_path: str) -> dict:
    try:
        absolute_path = resolve_stored_image_path(image_path)
        os.unlink(absolute_path)
        return {"message": "图片删除成功", "data": {"success": True}}
    except BizError:
        raise
    except Exception:
        return {"message": "图片删除失败", "data": {"success": False}}
