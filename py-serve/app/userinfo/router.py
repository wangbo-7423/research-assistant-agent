from fastapi import APIRouter, Depends, Request

from ..deps import get_db, get_current_user
from ..response import wrap_response
from .dto import LoginUserDto, RegisterDto
from .service import USER_COLLECTION, login_user, register_user

router = APIRouter(prefix="/userinfo")


@router.post("/registeruser")
async def register(body: RegisterDto, request: Request):
    from ..response import BizError

    if body.password != body.confirmPassWord:
        raise BizError("Password does not match", 400)
    users = get_db()[USER_COLLECTION]
    result = await register_user(users, body.phoneNumber, body.password)
    return wrap_response(result, request.url.path)


@router.post("/loginuser")
async def login(body: LoginUserDto, request: Request):
    users = get_db()[USER_COLLECTION]
    result = await login_user(users, body.phoneNumber, body.password)
    return wrap_response(result, request.url.path)


@router.get("/me")
async def me(user: dict = Depends(get_current_user)):
    """轻量自检接口：验证 token 有效性（前端未使用，调试用）。"""
    return {"userId": user.get("token")}
