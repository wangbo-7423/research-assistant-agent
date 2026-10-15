"""文件管理路由：知识库/对话框上传、检索、列表、删除、图片上传。

对应 NestJS 版 FileanagementController（去掉 wiki 编译相关接口）。
"""
from fastapi import APIRouter, Depends, File, Request, UploadFile
from pydantic import BaseModel

from ..config import Config
from ..deps import AuthUser, get_current_user, get_db
from ..response import BizError, wrap_response
from . import service
from .image_storage import (
    ALLOWED_IMAGE_TYPES,
    IMAGE_PUBLIC_ROUTE,
    UPLOAD_ROOT,
    assert_image_signature,
    create_stored_image_filename,
    delete_image_file,
    ensure_image_upload_dir,
)
from .service import FILE_COLLECTION, validate_doc_file

router = APIRouter(prefix="/fileanagement")

MAX_IMAGE_SIZE = 10 * 1024 * 1024  # 10MB


async def _read_doc_files(files: list[UploadFile]) -> list[tuple[str, str, int, bytes]]:
    result = []
    for file in files:
        if file.filename is None:
            continue
        content = await file.read()
        mimetype = file.content_type or ""
        validate_doc_file(file.filename, mimetype, len(content))
        result.append((file.filename, mimetype, len(content), content))
    return result


@router.post("/knowledge")
async def upload_knowledge(
    request: Request,
    file: list[UploadFile] = File(..., description="知识库文件，字段名 file，最多3个"),
    user: AuthUser = Depends(get_current_user),
):
    if len(file) > 3:
        raise BizError("最多只能上传3个文件", 400)
    payload = await _read_doc_files(file)
    user_id = user.user_id
    result = await service.handle_upload(payload, user_id, "UD", get_db()[FILE_COLLECTION])
    return wrap_response(result, request.url.path)


@router.post("/dialog")
async def upload_dialog(
    request: Request,
    file: list[UploadFile] = File(..., description="对话框文件，字段名 file，最多3个"),
    user: AuthUser = Depends(get_current_user),
):
    if len(file) > 3:
        raise BizError("最多只能上传3个文件", 400)
    payload = await _read_doc_files(file)
    user_id = user.user_id
    result = await service.handle_upload(payload, user_id, "UB", get_db()[FILE_COLLECTION])
    return wrap_response(result, request.url.path)


class SearchDto(BaseModel):
    query: str
    limit: int | None = 10


@router.post("/search")
async def search(body: SearchDto, request: Request, user: AuthUser = Depends(get_current_user)):
    result = await service.vector_search(body.query, user.user_id, body.limit or 10)
    return wrap_response(result, request.url.path)


@router.get("/kbfilelist")
async def kbfile_list(request: Request, user: AuthUser = Depends(get_current_user)):
    result = await service.get_kb_file_list(user.user_id, get_db()[FILE_COLLECTION])
    return wrap_response({"result": result, "message": "success"}, request.url.path)


@router.get("/{file_id}")
async def get_file(file_id: str, request: Request, user: AuthUser = Depends(get_current_user)):
    result = await service.get_file_content(file_id, get_db()[FILE_COLLECTION])
    return wrap_response(result, request.url.path)


@router.delete("/knowledge/{file_id}")
async def delete_knowledge_file(
    file_id: str, request: Request, user: AuthUser = Depends(get_current_user)
):
    result = await service.delete_file(file_id, user.user_id, "UD", get_db()[FILE_COLLECTION])
    return wrap_response(result, request.url.path)


@router.delete("/dialog/{file_id}")
async def delete_dialog_file(
    file_id: str, request: Request, user: AuthUser = Depends(get_current_user)
):
    result = await service.delete_file(file_id, user.user_id, "UB", get_db()[FILE_COLLECTION])
    return wrap_response(result, request.url.path)


@router.post("/uploadimage")
async def upload_image(
    request: Request,
    file: UploadFile = File(..., description="图片文件"),
    user: AuthUser = Depends(get_current_user),
):
    if not file.filename:
        raise BizError("请选择要上传的图片", 400)
    mimetype = file.content_type or ""
    if mimetype not in ALLOWED_IMAGE_TYPES:
        raise BizError(f"不支持的图片类型: {mimetype}", 400)
    content = await file.read()
    if len(content) <= 0:
        raise BizError("图片内容不能为空", 400)
    if len(content) > MAX_IMAGE_SIZE:
        raise BizError("图片大小不能超过 10MB", 400)

    ensure_image_upload_dir()
    filename = create_stored_image_filename(file.filename.split(".")[0] or "image", mimetype)
    target = UPLOAD_ROOT / filename
    target.write_bytes(content)
    # 校验文件魔数，失败则删除已落盘文件
    try:
        assert_image_signature(target, mimetype)
    except BizError:
        target.unlink(missing_ok=True)
        raise

    base_url = Config.IMAGE_BASE_URL_LOCAL.rstrip("/")
    public_base = base_url if base_url.endswith(IMAGE_PUBLIC_ROUTE) else f"{base_url}{IMAGE_PUBLIC_ROUTE}"
    return wrap_response(
        {
            "message": "图片上传成功",
            "data": {
                "success": True,
                "image": {
                    "imagePath": f"uploads-image/{filename}",
                    "mimetype": mimetype,
                    "imageUrl": f"{public_base}/{filename}",
                },
            },
        },
        request.url.path,
    )


class DeleteImageDto(BaseModel):
    imagePath: str


@router.post("/deleteimage")
async def delete_image(request: Request, body: DeleteImageDto, user: AuthUser = Depends(get_current_user)):
    return wrap_response(delete_image_file(body.imagePath), request.url.path)
