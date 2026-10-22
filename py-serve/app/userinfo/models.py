"""`userinfos` 集合的文档结构。"""
from datetime import datetime

from pydantic import Field

from ..core.models import MongoDocument


class UserDocument(MongoDocument):
    phonenumber: str
    password: str  # HMAC-SHA256 散列后的值，不存明文
    createdAt: datetime = Field(default_factory=datetime.now)
