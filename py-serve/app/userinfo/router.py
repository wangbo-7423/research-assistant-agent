from fastapi import APIRouter, Depends, Request

from ..core.deps import AuthUser, get_current_user, get_db
from ..core.response import wrap_response
from .schemas import LoginUserDto, RegisterDto
from .service import USER_COLLECTION, login_user, register_user

router = APIRouter(prefix="/userinfo")


@router.post("/registeruser")
async def register(body: RegisterDto, request: Request):
    from ..core.response import BizError

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
async def me(request: Request, user: AuthUser = Depends(get_current_user)):
    """轻量自检接口：验证 token 有效性（前端未使用，调试用）。"""
    return wrap_response({"userId": user.user_id}, request.url.path)
