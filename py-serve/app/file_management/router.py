"""文件管理路由：知识库/对话框上传、检索、列表、删除。

对应 NestJS 版 FileanagementController。
图片不再有独立上传接口：随 /chat/sendmessage 内联提交，由
file_management.image_storage.save_inline_images 落盘。
"""
from fastapi import APIRouter, Depends, File, Request, UploadFile

from ..core.deps import AuthUser, get_current_user, get_db
from ..core.response import BizError, wrap_response
from . import service
from .schemas import SearchDto
from .sections import SECTION_COLLECTION
from .service import FILE_COLLECTION, validate_doc_file

router = APIRouter(prefix="/file_management")


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
    db = get_db()
    result = await service.handle_upload(
        payload, user_id, "UD", db[FILE_COLLECTION], db[SECTION_COLLECTION]
    )
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
    db = get_db()
    result = await service.handle_upload(
        payload, user_id, "UB", db[FILE_COLLECTION], db[SECTION_COLLECTION]
    )
    return wrap_response(result, request.url.path)


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
    db = get_db()
    result = await service.delete_file(
        file_id, user.user_id, "UD", db[FILE_COLLECTION], db[SECTION_COLLECTION]
    )
    return wrap_response(result, request.url.path)


@router.delete("/dialog/{file_id}")
async def delete_dialog_file(
    file_id: str, request: Request, user: AuthUser = Depends(get_current_user)
):
    db = get_db()
    result = await service.delete_file(
        file_id, user.user_id, "UB", db[FILE_COLLECTION], db[SECTION_COLLECTION]
    )
    return wrap_response(result, request.url.path)


