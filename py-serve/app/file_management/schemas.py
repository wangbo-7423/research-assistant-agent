"""文件管理模块的请求体定义（schema 层，与路由解耦）。"""
from pydantic import BaseModel


class SearchDto(BaseModel):
    query: str
    limit: int | None = 10
