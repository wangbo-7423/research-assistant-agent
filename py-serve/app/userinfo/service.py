"""用户注册/登录服务：HMAC-SHA256 密码散列 + JWT 签发（与 NestJS 版一致）。"""
import hashlib
import hmac
from datetime import datetime, timedelta, timezone

import jwt
from bson import ObjectId
from pymongo.asynchronous.collection import AsyncCollection

from ..config import Config

USER_COLLECTION = "userinfos"


def hash_password(password: str) -> str:
    return hmac.new(
        Config.PASSWORD_KEY.encode(), password.encode(), hashlib.sha256
    ).hexdigest()


def create_token(user_id: ObjectId) -> str:
    payload = {
        "token": str(user_id),
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(days=Config.JWT_EXPIRE_DAYS),
    }
    return jwt.encode(payload, Config.JWT_SECRET, algorithm="HS256")


async def register_user(users: AsyncCollection, phone: str, password: str) -> dict:
    query = await users.find({"phonenumber": phone}).to_list(1)
    if query:
        return {"message": "该账号已存在", "data": [], "code": 422}
    result = await users.insert_one({"phonenumber": phone, "password": hash_password(password)})
    token = create_token(result.inserted_id)
    return {"message": "SUCCESS", "data": {"token": token, "phonenumber": phone}}


async def login_user(users: AsyncCollection, phone: str, password: str) -> dict:
    doc = await users.find_one({"phonenumber": phone, "password": hash_password(password)})
    if doc:
        token = create_token(doc["_id"])
        return {"message": "SUCCESS", "data": {"token": token, "phonenumber": phone}}
    return {"message": "账号或密码错误", "data": [], "code": 422}
