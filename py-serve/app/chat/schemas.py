"""对话模块的请求体定义（schema 层，与路由解耦）。"""
from pydantic import BaseModel


class UploadFileRefDto(BaseModel):
    fileName: str
    fileSize: str
    fileType: str
    docId: str


class UploadImageDto(BaseModel):
    imagePath: str
    mimetype: str
    imageUrl: str


class SendMessageDto(BaseModel):
    content: str
    sessionId: str
    uploadFileList: list[UploadFileRefDto] | None = None
    isKnowledgeBased: bool | None = None
    uploadImageList: UploadImageDto | None = None
