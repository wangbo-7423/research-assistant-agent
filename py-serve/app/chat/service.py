"""对话服务：朴素 RAG 链路（对应 NestJS 版旧链路 modelResult → queryKb）。

流程：
  1. 组合用户消息（文档阅读 / 图片 / 纯文本），管理会话历史（Redis 缓存 + MongoDB）
  2. 第一轮调用：意图识别工具（isKnowledgeBased 时强制调用），续问改写
  3. queryKb：混合检索（向量 + 关键词 RRF 融合）→ 第二轮调用（注入知识库规则）流式回答
"""
import asyncio
import json
import traceback
from datetime import datetime

from bson import ObjectId

from ..config import Config
from ..deps import redis_client
from ..fileanagement.embeddings import embedding_client
from ..fileanagement.image_storage import assert_image_signature, resolve_stored_image_path
from ..fileanagement.service import hybrid_search, query_files_by_ids
from .prompts import TOOLS_DATA, build_system_prompt

CHAT_COLLECTION = "chatdata"
STREAM_SEPARATOR = "###ABC###"
HISTORY_TTL = 10800  # redis 会话缓存 3 个小时过期

_LLM_CLIENT = None


def _llm_client():
    """对话/视觉统一走 DeepSeek（deepseek-flash 自带多模态）；embedding 仍走通义。"""
    global _LLM_CLIENT
    if _LLM_CLIENT is None:
        from openai import AsyncOpenAI

        _LLM_CLIENT = AsyncOpenAI(
            api_key=Config.DEEPSEEK_API_KEY,
            base_url=Config.DEEPSEEK_BASE_URL,
            timeout=60,
            max_retries=2,
        )
    return _LLM_CLIENT


class StreamWriter:
    """以 asyncio.Queue 模拟 Express 的 res.write / res.end 流式响应。"""

    def __init__(self):
        self.queue: asyncio.Queue = asyncio.Queue()
        self._closed = False

    async def notify(self, stream_data: dict) -> None:
        if self._closed:
            return
        await self.queue.put(json.dumps(stream_data, ensure_ascii=False) + STREAM_SEPARATOR)

    async def end(self) -> None:
        if not self._closed:
            self._closed = True
            await self.queue.put(None)

    async def stream(self):
        while True:
            item = await self.queue.get()
            if item is None:
                break
            yield item


def _kb_size(size_bytes) -> str:
    try:
        return f"{float(size_bytes) / 1024:.1f}KB"
    except (TypeError, ValueError):
        return "0.0KB"


def _strip_message(message: dict) -> dict:
    return {"role": message["role"], "content": message["content"]}


async def calling_model(
    messages_list: list[dict],
    is_knowledge_based: bool = False,
    with_kb_rules: bool = False,
):
    """调用文本模型（DeepSeek）。注意：thinking 模式不支持强制 tool_choice，
    意图识别需要强制调用工具，因此必须显式关闭 thinking。"""
    kwargs: dict = {
        "model": Config.DEEPSEEK_MODEL,
        "messages": [
            {"role": "system", "content": build_system_prompt(with_kb_rules)},
            *[_strip_message(m) for m in messages_list],
        ],
        "stream": True,
        "tools": TOOLS_DATA,
        "tool_choice": (
            {"type": "function", "function": {"name": "clarify_intent"}}
            if is_knowledge_based
            else "none"
        ),
        "extra_body": {"thinking": {"type": "disabled"}},
    }
    return await _llm_client().chat.completions.create(**kwargs)


async def encode_image(image_path: str, mimetype: str) -> dict:
    """将服务端已校验的图片转换为 base64，交给多模态大模型。"""
    absolute_path = resolve_stored_image_path(image_path)
    assert_image_signature(absolute_path, mimetype)
    import base64

    base64_image = base64.b64encode(absolute_path.read_bytes()).decode()
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{mimetype};base64,{base64_image}"},
    }


async def model_vl_res(message_list: list[dict], image_url_obj: dict):
    """调用多模态大模型，理解图片（deepseek-flash 自带视觉能力）。"""
    last_user_message = message_list[-1]
    return await _llm_client().chat.completions.create(
        model=Config.DEEPSEEK_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    f"{build_system_prompt()}\n\n图片理解要求：先客观描述图片中的关键信息，"
                    "再结合用户问题进行分析；涉及图表时提取趋势、对比、异常点和可读出的数据；"
                    "无法从图片确认的内容要明确说明，不要臆造。"
                ),
            },
            {
                "role": "user",
                "content": [
                    image_url_obj,
                    {"type": "text", "text": last_user_message["content"]},
                ],
            },
        ],
        stream=True,
        extra_body={"thinking": {"type": "disabled"}},
    )


async def combine_convo(
    write: StreamWriter,
    user_id: str,
    session_id: str,
    content: str,
    upload_file_list: list[dict] | None,
    upload_image_list: dict | None,
    is_knowledge_based: bool | None,
    files_col,
    chat_col,
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
                "fileName": d.get("fileName"),
                "fileSize": _kb_size(d.get("fileSize")),
                "fileType": d.get("fileType"),
                "docId": str(d["_id"]),
            }
            for d in docs
        ]
        document_content = "\n\n---\n\n".join(d.get("fileText") or "" for d in docs)
        messages["content"] = f"用户上传的文档内容如下:\n{document_content}\n请基于文档内容回复用户问题:{content}"
        messages["displayContent"] = content
        messages["uploadFileList"] = upload_file_list_data
        read_file_list = {
            "type": "readDocument",
            "statusInfo": "completed",
            "promptInfo": "已阅读文档",
            "fileList": [d["fileName"] for d in upload_file_list_data],
        }

    # 如果用户上传图片
    if upload_image_list:
        is_knowledge_based = False
        messages["uploadImageList"] = upload_image_list

    # 请求数据库：获取用户历史对话，组合上下文，让模型有记忆能力
    is_new_session = session_id == "null"
    real_session_id: ObjectId | str = session_id
    if is_new_session:
        now = datetime.now()
        created = await chat_col.insert_one(
            {
                "userId": ObjectId(user_id),
                "createDate": now.strftime("%Y-%m-%d"),
                "createTime": int(now.timestamp() * 1000),
                "chatList": [messages],
            }
        )
        real_session_id = created.inserted_id
        await write.notify({"type": "sessionId", "sessionId": str(real_session_id)})
        history_convo_list: list[dict] = [messages]
    else:
        try:
            session_oid = ObjectId(session_id)
        except Exception:
            session_oid = None
        history_convo_list = []
        if session_oid is not None:
            redis_key = f"chat_history:{user_id}:{session_id}"
            cached = await redis_client.get(redis_key)
            if cached:
                history_convo_list = json.loads(cached)
            else:
                chat_data = await chat_col.find_one({"userId": ObjectId(user_id), "_id": session_oid})
                history_convo_list = (chat_data or {}).get("chatList") or []
                await redis_client.set(
                    redis_key, json.dumps(history_convo_list, ensure_ascii=False), ex=HISTORY_TTL
                )
        history_convo_list.append(messages)

    # 调用模型（slice 不改动原数组，完整历史留给持久化）
    print("对话数据")
    print(json.dumps(history_convo_list, ensure_ascii=False))
    assistant_message = await model_result(
        write,
        history_convo_list[-21:],
        is_knowledge_based,
        user_id,
        real_session_id,
        upload_file_list,
        read_file_list,
        upload_image_list,
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


async def persist_convo(
    user_id: str,
    session_id: ObjectId | str,
    full_convo_list: list[dict],
    user_message: dict,
    assistant_message: dict | None,
    is_new_session: bool,
    chat_col,
) -> None:
    """持久化对话记录：把本轮消息追加到 mongodb 的 chatList，并刷新 redis 缓存。"""
    try:
        # 新会话创建时已写入用户消息，这里只需要追加助手回复；老会话需要追加用户消息
        new_messages: list[dict] = [] if is_new_session else [user_message]
        if assistant_message and assistant_message.get("content"):
            new_messages.append(assistant_message)
            full_convo_list.append(assistant_message)
        if new_messages:
            await chat_col.update_one(
                {"_id": ObjectId(str(session_id)), "userId": ObjectId(user_id)},
                {"$push": {"chatList": {"$each": new_messages}}},
            )
        redis_key = f"chat_history:{user_id}:{session_id}"
        await redis_client.set(
            redis_key, json.dumps(full_convo_list, ensure_ascii=False), ex=HISTORY_TTL
        )
    except Exception as e:
        # 持久化失败不影响本次对话响应
        print("对话记录持久化失败")
        print(e)


async def model_result(
    write: StreamWriter,
    message_list: list[dict],
    is_knowledge_based: bool | None,
    user_id: str,
    session_id,
    upload_file_list: list[dict] | None,
    read_file_list: dict | None,
    upload_image_list: dict | None,
) -> dict | None:
    """模型输出结果（返回助手完整回复，用于持久化；失败返回 None）。"""
    try:
        if upload_image_list:
            image_url_obj = await encode_image(upload_image_list["imagePath"], upload_image_list["mimetype"])
            res = await model_vl_res(message_list, image_url_obj)
        else:
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
                    print(f"工具生成了新问题-----{clarified}")
                    return await query_kb(write, clarified, message_list, user_id, read_file_list)
                print("工具没有生成新问题")
                last_item = message_list[-1]
                return await query_kb(write, last_item["content"], message_list, user_id, read_file_list)
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
        print("调用模型出错")
        traceback.print_exc()
        try:
            await write.notify({"type": "error", "content": "模型服务异常，请稍后重试"})
            await write.end()
        except Exception:
            pass
        return None


async def query_kb(
    write: StreamWriter,
    user_question: str,
    message_list: list[dict],
    user_id: str,
    read_file_list: dict | None,
) -> dict | None:
    """根据用户问题，检索知识库并回答（返回助手完整回复，用于持久化；失败返回 None）。"""
    await write.notify(
        {"type": "queryKB", "statusInfo": "inProgress", "promptInfo": "正在检索知识库", "fileList": []}
    )
    answer_content = ""
    kb_read_file_data: dict | None = None
    try:
        # 1. 混合检索：对用户问题 embedding + 向量检索 + 关键词检索 + RRF 融合
        search_res = await hybrid_search(user_question, user_id, 5)
        hits = search_res.get("results") or []

        # 2. 告知前端检索完成及命中的文件
        hit_file_names = list(dict.fromkeys(h.get("docTitle") for h in hits if h.get("docTitle")))
        kb_read_file_data = {
            "type": "queryKB",
            "statusInfo": "completed",
            "promptInfo": "知识库检索完成" if hits else "知识库未检索到相关内容",
            "fileList": hit_file_names,
        }
        await write.notify(kb_read_file_data)

        # 3. 拼接检索结果；无命中时使用约定占位符，交给系统提示词规则处理
        kb_content = (
            "\n\n".join(f"【片段{i + 1}·{h.get('docTitle')}】\n{h.get('docText')}" for i, h in enumerate(hits))
            if hits
            else "&没有检索到相关文档&"
        )

        # 4. 组装带知识库上下文的对话并调用模型（流式）
        kb_messages = [
            *message_list[:-1],
            {
                "role": "user",
                "content": f"知识库检索结果如下：\n{kb_content}\n\n请基于上述检索结果回答用户问题：{user_question}",
            },
        ]
        res = await calling_model(kb_messages, False, True)
        async for chunk in res:
            choices = chunk.choices
            if not choices:
                continue
            delta = choices[0].delta
            if delta and delta.content:
                answer_content += delta.content
                await write.notify({"type": "answer", "content": delta.content})

        if not answer_content:
            return None
        return {"role": "assistant", "content": answer_content, "readFileData": kb_read_file_data}
    except Exception:
        print("检索知识库出错")
        traceback.print_exc()
        await write.notify(
            {
                "type": "queryKB",
                "statusInfo": "completed",
                "promptInfo": "知识库检索失败，请稍后重试",
                "fileList": [],
            }
        )
        return None
    finally:
        await write.end()


# ---------------------------------------------------------------- 会话管理


async def get_session_list(user_id: str, chat_col) -> list[dict]:
    cursor = (
        chat_col.find({"userId": ObjectId(user_id)}, {"createDate": 1, "createTime": 1, "chatList": 1})
        .sort("createTime", -1)
    )
    result = []
    async for item in cursor:
        chat_list = item.get("chatList") or []
        first_user_message = next((m for m in chat_list if m.get("role") == "user"), None)
        raw_title = (
            (first_user_message or {}).get("displayContent")
            or (first_user_message or {}).get("content")
            or "新对话"
        )
        result.append(
            {
                "sessionId": str(item["_id"]),
                "createDate": item.get("createDate"),
                "createTime": item.get("createTime"),
                "title": raw_title[:30] + "..." if len(raw_title) > 30 else raw_title,
                "messageCount": len(chat_list),
            }
        )
    return result


async def delete_session(user_id: str, session_id: str, chat_col) -> dict:
    try:
        session_oid = ObjectId(session_id)
    except Exception:
        return {"deleted": False}
    result = await chat_col.delete_one({"userId": ObjectId(user_id), "_id": session_oid})
    await redis_client.delete(f"chat_history:{user_id}:{session_id}")
    return {"deleted": result.deleted_count > 0}


async def get_history(user_id: str, session_id: str, chat_col) -> dict:
    """查询某个会话的完整对话记录：优先 redis，未命中回源 mongodb 并回填缓存。"""
    try:
        session_oid = ObjectId(session_id)
    except Exception:
        return {"sessionId": session_id, "chatList": []}
    redis_key = f"chat_history:{user_id}:{session_id}"
    cached = await redis_client.get(redis_key)
    if cached:
        return {"sessionId": session_id, "chatList": json.loads(cached)}
    chat_data = await chat_col.find_one({"userId": ObjectId(user_id), "_id": session_oid})
    chat_list = (chat_data or {}).get("chatList") or []
    await redis_client.set(redis_key, json.dumps(chat_list, ensure_ascii=False), ex=HISTORY_TTL)
    return {"sessionId": session_id, "chatList": chat_list}
