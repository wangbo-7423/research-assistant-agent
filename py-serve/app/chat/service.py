"""对话编排：组合用户消息 → 首轮意图识别/续问改写 → 检索回答 → 落库。

拆分后的模块职责（本文件只保留编排，不直接碰模型/存储细节）：
  llm.py        模型调用（文本对话 + 原生多模态消息组装）
  stream.py     SSE 流式写端
  retrieval.py  知识库检索问答（query_kb）
  session.py    会话创建、历史读取、落库与缓存
  service.py    串联上述步骤（对外入口 combine_convo）
"""
import json
import logging

from bson import ObjectId

from ..core.response import BizError
from ..file_management.image_storage import save_inline_images
from ..file_management.service import query_files_by_ids
from .llm import calling_model
from .retrieval import query_kb
from .session import create_session, load_history, persist_convo
from .stream import StreamWriter

logger = logging.getLogger(__name__)


def _kb_size(size_bytes) -> str:
    try:
        return f"{float(size_bytes) / 1024:.1f}KB"
    except (TypeError, ValueError):
        return "0.0KB"


async def combine_convo(
    write: StreamWriter,
    user_id: str,
    session_id: str,
    content: str,
    upload_file_list: list[dict] | None,
    inline_images: list[dict] | None,
    is_knowledge_based: bool | None,
    files_col,
    chat_col,
    sections_col,
) -> None:
    # 组合对话字段：用户发送给模型的对话字段类型
    messages: dict = {"role": "user", "content": content}
    read_file_list: dict | None = None

    # 判断用户是否携带文档
    if upload_file_list:
        # 如果用户上传文档，禁用知识库功能
        is_knowledge_based = False
        await write.notify(
            {"type": "readDocument", "statusInfo": "inProgress", "promptInfo": "正在阅读文档", "fileList": []}
        )
        try:
            doc_ids = [ObjectId(item["docId"]) for item in upload_file_list]
        except Exception:
            await write.notify({"type": "error", "content": "文件不存在，请重新上传"})
            await write.end()
            return
        docs = await query_files_by_ids(user_id, doc_ids, files_col)
        if not docs:
            await write.notify({"type": "error", "content": "文件不存在，请重新上传"})
            await write.end()
            return
        upload_file_list_data = [
            {
                "fileName": d.fileName,
                "fileSize": _kb_size(d.fileSize),
                "fileType": d.fileType,
                "docId": str(d.id) if d.id else "",
            }
            for d in docs
        ]
        document_content = "\n\n---\n\n".join(d.fileText for d in docs)
        messages["content"] = f"用户上传的文档内容如下:\n{document_content}\n请基于文档内容回复用户问题:{content}"
        messages["displayContent"] = content
        messages["uploadFileList"] = upload_file_list_data
        read_file_list = {
            "type": "readDocument",
            "statusInfo": "completed",
            "promptInfo": "已阅读文档",
            "fileList": [d["fileName"] for d in upload_file_list_data],
        }

    # 用户粘贴的图片：先落盘，消息里只保留路径（base64 绝不入库）
    if inline_images:
        is_knowledge_based = False
        try:
            messages["uploadImageList"] = save_inline_images(inline_images)
        except BizError as error:
            await write.notify({"type": "error", "content": error.message})
            await write.end()
            return

    # 请求数据库：获取用户历史对话，组合上下文，让模型有记忆能力
    is_new_session = session_id == "null"
    real_session_id: ObjectId | str = session_id
    history_convo_list: list[dict]
    if is_new_session:
        real_session_id = await create_session(user_id, messages, chat_col)
        await write.notify({"type": "sessionId", "sessionId": str(real_session_id)})
        history_convo_list = [messages]
    else:
        history_convo_list = await load_history(user_id, session_id, chat_col)
        history_convo_list.append(messages)

    # 调用模型（slice 不改动原数组，完整历史留给持久化）
    # 只打印摘要：完整历史含文档正文，打日志会膨胀并可能带出用户隐私
    logger.debug(
        "本轮对话 session=%s 消息数=%s 图片数=%s 文档数=%s 知识库=%s",
        real_session_id,
        len(history_convo_list),
        len(messages.get("uploadImageList") or []),
        len(upload_file_list or []),
        is_knowledge_based,
    )
    assistant_message = await model_result(
        write,
        history_convo_list[-21:],
        is_knowledge_based,
        user_id,
        real_session_id,
        upload_file_list,
        read_file_list,
        sections_col,
    )
    await persist_convo(
        user_id,
        real_session_id,
        history_convo_list,
        messages,
        assistant_message,
        is_new_session,
        chat_col,
    )


async def model_result(
    write: StreamWriter,
    message_list: list[dict],
    is_knowledge_based: bool | None,
    user_id: str,
    session_id,
    upload_file_list: list[dict] | None,
    read_file_list: dict | None,
    sections_col,
) -> dict | None:
    """模型输出结果（返回助手完整回复，用于持久化；失败返回 None）。

    图片已并入 message_list（见 llm.calling_model），这里不再区分视觉/文本两条链路。
    """
    try:
        res = await calling_model(message_list, bool(is_knowledge_based))

        # 如果用户携带文档对话，在这里返回前端
        if upload_file_list and read_file_list:
            await write.notify(read_file_list)

        tool_call_args_str = ""
        is_tool_call_started = False
        answer_content = ""
        async for chunk in res:
            choices = chunk.choices
            if not choices:
                continue
            delta = choices[0].delta
            if delta is None:
                continue
            # 判断是否开始调用工具
            if delta.tool_calls and delta.tool_calls[0].function and delta.tool_calls[0].function.arguments:
                tool_call_args_str += delta.tool_calls[0].function.arguments
                is_tool_call_started = True
            finish_reason = choices[0].finish_reason
            if finish_reason in ("stop", "tool_calls") and is_tool_call_started:
                # 取出新问题（工具可能返回空参数字符串，解析失败时安全降级）
                new_question = None
                try:
                    new_question = json.loads(tool_call_args_str) if tool_call_args_str.strip() else None
                except json.JSONDecodeError:
                    new_question = None
                clarified = None
                if isinstance(new_question, dict):
                    candidate = new_question.get("clarified_question")
                    if isinstance(candidate, str) and candidate.strip():
                        clarified = candidate
                if clarified:
                    logger.info("意图工具生成了新问题: %s", clarified)
                    return await query_kb(
                        write, clarified, message_list, user_id, read_file_list, sections_col
                    )
                logger.info("意图工具没有生成新问题，沿用原问题检索")
                last_item = message_list[-1]
                return await query_kb(
                    write, last_item["content"], message_list, user_id, read_file_list, sections_col
                )
            # 普通回复：流式推给前端，同时累积完整内容
            if delta.content:
                answer_content += delta.content
                await write.notify({"type": "answer", "content": delta.content})

        # 模型异常或内容为空时不落库助手消息
        if not answer_content:
            await write.notify({"type": "error", "content": "模型没有返回内容，请稍后重试"})
            await write.end()
            return None
        await write.end()
        assistant_message: dict = {"role": "assistant", "content": answer_content}
        if read_file_list:
            assistant_message["readFileData"] = read_file_list
        return assistant_message
    except Exception:
        logger.exception("调用模型出错")
        try:
            await write.notify({"type": "error", "content": "模型服务异常，请稍后重试"})
            await write.end()
        except Exception:
            pass
        return None
