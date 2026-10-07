"""对话路由：流式问答 + 会话管理（对应 NestJS 版 ChatController）。"""
import asyncio
import traceback

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..deps import get_current_user, get_db
from ..response import BizError, wrap_response
from . import service
from .service import CHAT_COLLECTION, StreamWriter

router = APIRouter(prefix="/chat")


class UploadFileRefDto(BaseModel):
    fileName: str
    fileSize: str
    fileType: str
    docId: str


class UploadImageDto(BaseModel):
    imagePath: str
    mimetype: str
    imageUrl: str


class SendMessageDto(BaseModel):
    content: str
    sessionId: str
    uploadFileList: list[UploadFileRefDto] | None = None
    isKnowledgeBased: bool | None = None
    uploadImageList: UploadImageDto | None = None


@router.post("/sendmessage")
async def send_message(body: SendMessageDto, request: Request, user: dict = Depends(get_current_user)):
    if not body.content or not body.content.strip():
        raise BizError("请输入问题", 400)

    user_id = user.get("token")
    db = get_db()
    files_col = db["fileanagements"]
    chat_col = db[CHAT_COLLECTION]
    write = StreamWriter()

    async def run():
        try:
            await service.combine_convo(
                write,
                user_id,
                body.sessionId,
                body.content,
                [f.model_dump() for f in body.uploadFileList] if body.uploadFileList else None,
                body.uploadImageList.model_dump() if body.uploadImageList else None,
                body.isKnowledgeBased,
                files_col,
                chat_col,
            )
        except Exception:
            traceback.print_exc()
            try:
                await write.notify({"type": "error", "content": "模型服务异常，请稍后重试"})
            finally:
                await write.end()

    asyncio.create_task(run())
    return StreamingResponse(
        write.stream(),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/sessionlist")
async def session_list(request: Request, user: dict = Depends(get_current_user)):
    result = await service.get_session_list(user.get("token"), get_db()[CHAT_COLLECTION])
    return wrap_response(result, request.url.path)


@router.get("/history")
async def history(request: Request, sessionId: str, user: dict = Depends(get_current_user)):
    if not sessionId:
        raise BizError("对话id不能为空", 400)
    result = await service.get_history(user.get("token"), sessionId, get_db()[CHAT_COLLECTION])
    return wrap_response(result, request.url.path)


@router.delete("/deletesession")
async def delete_session(request: Request, sessionId: str, user: dict = Depends(get_current_user)):
    result = await service.delete_session(user.get("token"), sessionId, get_db()[CHAT_COLLECTION])
    return wrap_response(result, request.url.path)
