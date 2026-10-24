"""对话模块的请求体定义（schema 层，与路由解耦）。"""
from pydantic import BaseModel


class UploadFileRefDto(BaseModel):
    fileName: str
    fileSize: str
    fileType: str
    docId: str


class InlineImageDto(BaseModel):
    """粘贴的图片：base64 内联提交，后端落盘后只保留路径。"""

    mimetype: str
    data: str  # base64，不含 data: 前缀
    fileName: str | None = None
    fileSize: int | None = None


class SendMessageDto(BaseModel):
    content: str = ""
    sessionId: str
    uploadFileList: list[UploadFileRefDto] | None = None
    images: list[InlineImageDto] | None = None
    isKnowledgeBased: bool | None = None
