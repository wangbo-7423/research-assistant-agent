"""`chatdata` 集合的文档结构：一个文档 = 一个会话，聊天记录存在 chatList 数组里。

注意：这里的 userId 存的是 ObjectId，而 `fileanagements.userId` 存的是字符串，
两边不统一是历史遗留，模型按各自的真实类型声明。
"""
from datetime import datetime
from typing import Any, Literal

from bson import ObjectId
from pydantic import Field

from ..core.models import MongoDocument


class ChatMessage(MongoDocument):
    """chatList 数组里的一条消息。"""

    role: Literal["user", "assistant"]
    content: str = ""  # 发给模型的完整内容（带文档正文时远长于用户输入）
    displayContent: str | None = None  # 前端展示用的内容（上传文档时保留用户原话）
    uploadFileList: list[dict[str, Any]] | None = None
    uploadImageList: dict[str, Any] | None = None
    readFileData: dict[str, Any] | None = None  # 助手消息上的「已阅读文档」卡片数据
    citations: list[dict[str, Any]] | None = None  # 知识库回答的出处列表，与正文 [N] 对应


class ChatSessionDocument(MongoDocument):
    userId: ObjectId
    createDate: str  # "%Y-%m-%d"，前端列表按日期分组
    createTime: int  # 毫秒时间戳，用于排序
    chatList: list[ChatMessage] = Field(default_factory=list)

    @classmethod
    def new(cls, user_id: str, first_message: dict[str, Any], now: datetime | None = None) -> "ChatSessionDocument":
        """新建会话：首条用户消息随会话一起落库。"""
        now = now or datetime.now()
        return cls(
            userId=ObjectId(user_id),
            createDate=now.strftime("%Y-%m-%d"),
            createTime=int(now.timestamp() * 1000),
            chatList=[ChatMessage.from_mongo(first_message)],
        )


def message_payloads(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """校验待追加的消息，返回可直接 $push 进 chatList 的字典列表。"""
    return [ChatMessage.from_mongo(message).to_mongo() for message in messages]
