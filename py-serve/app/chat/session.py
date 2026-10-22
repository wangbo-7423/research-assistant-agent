"""会话存储：创建、历史读取、落库、会话列表与删除。

MongoDB 是持久化来源，Redis 只做 3 小时热缓存（会话历史是读多写少的场景）。
"""
import json

from bson import ObjectId

from ..core.deps import redis_client
from .models import ChatSessionDocument, message_payloads

CHAT_COLLECTION = "chatdata"
HISTORY_TTL = 10800  # redis 会话缓存 3 个小时过期


def _redis_key(user_id: str, session_id) -> str:
    return f"chat_history:{user_id}:{session_id}"


async def create_session(user_id: str, first_message: dict, chat_col) -> ObjectId:
    """新建会话：首条用户消息随会话一起落库（结构见 chat/models.py）。"""
    session = ChatSessionDocument.new(user_id, first_message)
    created = await chat_col.insert_one(session.to_mongo())
    return created.inserted_id


async def load_history(user_id: str, session_id: str, chat_col) -> list[dict]:
    """读会话历史：优先 redis，未命中回源 mongodb 并回填缓存。"""
    try:
        session_oid = ObjectId(session_id)
    except Exception:
        return []
    redis_key = _redis_key(user_id, session_id)
    cached = await redis_client.get(redis_key)
    if cached:
        return json.loads(cached)
    chat_data = await chat_col.find_one({"userId": ObjectId(user_id), "_id": session_oid})
    chat_list = (chat_data or {}).get("chatList") or []
    await redis_client.set(redis_key, json.dumps(chat_list, ensure_ascii=False), ex=HISTORY_TTL)
    return chat_list


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
                {"$push": {"chatList": {"$each": message_payloads(new_messages)}}},
            )
        await redis_client.set(
            _redis_key(user_id, session_id), json.dumps(full_convo_list, ensure_ascii=False), ex=HISTORY_TTL
        )
    except Exception as e:
        # 持久化失败不影响本次对话响应
        print("对话记录持久化失败")
        print(e)


async def get_session_list(user_id: str, chat_col) -> list[dict]:
    cursor = (
        chat_col.find({"userId": ObjectId(user_id)}, {"createDate": 1, "createTime": 1, "chatList": 1})
        .sort("createTime", -1)
    )
    result = []
    async for item in cursor:
        session = ChatSessionDocument.from_mongo(item)
        chat_list = session.chatList
        first_user = next((m for m in chat_list if m.role == "user"), None)
        raw_title = "新对话" if first_user is None else (first_user.displayContent or first_user.content or "新对话")
        result.append(
            {
                "sessionId": str(session.id or item["_id"]),
                "createDate": session.createDate,
                "createTime": session.createTime,
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
    await redis_client.delete(_redis_key(user_id, session_id))
    return {"deleted": result.deleted_count > 0}


async def get_history(user_id: str, session_id: str, chat_col) -> dict:
    """查询某个会话的完整对话记录（redis 优先，未命中回源 mongodb）。"""
    return {"sessionId": session_id, "chatList": await load_history(user_id, session_id, chat_col)}
