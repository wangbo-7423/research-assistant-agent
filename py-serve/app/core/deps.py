"""公共依赖：JWT 认证（对应 NestJS AuthGuard）与 MongoDB / Redis 连接。"""
from typing import Any

import jwt
import redis.asyncio as aioredis
from bson import ObjectId
from fastapi import Depends, Request
from pymongo import AsyncMongoClient

from .config import Config

mongo_client: AsyncMongoClient = AsyncMongoClient(Config.MONGODB_URI)

redis_client: aioredis.Redis = aioredis.Redis(
    host=Config.REDIS_HOST, port=Config.REDIS_PORT, decode_responses=True
)

def get_db():
    return mongo_client.get_default_database()


class AuthUser(dict):
    """JWT payload，user.token 即用户 ObjectId 字符串。"""

    @property
    def user_id(self) -> str:
        return str(self.get("token", ""))

    @property
    def object_id(self) -> ObjectId:
        return ObjectId(self.get("token"))


def _extract_token(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    parts = auth.split(" ")
    if len(parts) == 2 and parts[0] == "Bearer":
        return parts[1]
    return ""


def get_current_user(request: Request) -> AuthUser:
    token = _extract_token(request)
    if not token:
        raise _unauthorized("No token provided")
    try:
        payload: dict[str, Any] = jwt.decode(token, Config.JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise _unauthorized("token is invalid")
    if not payload.get("token"):
        raise _unauthorized("token is invalid")
    return AuthUser(payload)


def _unauthorized(message: str):
    from fastapi import HTTPException

    return HTTPException(status_code=401, detail=message)


async def verify_token(token: str) -> bool:
    """供 WebSocket 等场景使用：校验 token 是否有效。"""
    try:
        jwt.decode(token, Config.JWT_SECRET, algorithms=["HS256"])
        return True
    except Exception:
        return False


DependsAuth = Depends(get_current_user)
