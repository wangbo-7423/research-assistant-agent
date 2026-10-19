"""注册/登录 DTO 校验，错误信息与 NestJS class-validator 版一致。"""
import re

from pydantic import BaseModel, field_validator


def validate_phone(value: str) -> str:
    if not value:
        raise ValueError("phone number is required")
    if not re.fullmatch(r"1[3-9]\d{9}", value):
        raise ValueError("phone number must be 11 digits")
    return value


def validate_password(value: str) -> str:
    if not value:
        raise ValueError("password is required")
    if not re.fullmatch(r"(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{8,}", value):
        raise ValueError("密码长度至少8位，且至少包含一个大写字母、一个小写字母和一个数字。")
    return value


class LoginUserDto(BaseModel):
    phoneNumber: str
    password: str

    @field_validator("phoneNumber")
    @classmethod
    def _phone(cls, v: str) -> str:
        return validate_phone(v)

    @field_validator("password")
    @classmethod
    def _password(cls, v: str) -> str:
        return validate_password(v)


class RegisterDto(LoginUserDto):
    confirmPassWord: str

    @field_validator("confirmPassWord")
    @classmethod
    def _confirm(cls, v: str) -> str:
        if not v:
            raise ValueError("确认密码不能为空")
        return v
