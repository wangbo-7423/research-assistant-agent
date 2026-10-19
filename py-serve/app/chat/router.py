"""对话路由：流式问答 + 会话管理（对应 NestJS 版 ChatController）。"""
import asyncio
import traceback

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from ..core.deps import AuthUser, get_current_user, get_db
from ..core.response import BizError, wrap_response
from ..file_management.service import FILE_COLLECTION
from . import service
from .schemas import SendMessageDto
from .session import CHAT_COLLECTION, delete_session, get_history, get_session_list
from .stream import StreamWriter

router = APIRouter(prefix="/chat")


@router.post("/sendmessage")
async def send_message(body: SendMessageDto, request: Request, user: AuthUser = Depends(get_current_user)):
    if not body.content or not body.content.strip():
        raise BizError("请输入问题", 400)

    user_id = user.user_id
    db = get_db()
    files_col = db[FILE_COLLECTION]
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
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/sessionlist")
async def session_list(request: Request, user: AuthUser = Depends(get_current_user)):
    result = await get_session_list(user.user_id, get_db()[CHAT_COLLECTION])
    return wrap_response(result, request.url.path)


@router.get("/history")
async def history(request: Request, sessionId: str, user: AuthUser = Depends(get_current_user)):
    if not sessionId:
        raise BizError("对话id不能为空", 400)
    result = await get_history(user.user_id, sessionId, get_db()[CHAT_COLLECTION])
    return wrap_response(result, request.url.path)


@router.delete("/deletesession")
async def delete_session_route(request: Request, sessionId: str, user: AuthUser = Depends(get_current_user)):
    result = await delete_session(user.user_id, sessionId, get_db()[CHAT_COLLECTION])
    return wrap_response(result, request.url.path)
