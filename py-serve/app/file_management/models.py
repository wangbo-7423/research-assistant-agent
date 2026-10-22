"""`fileanagements` 集合的文档结构（MongoDB 无内建 schema，此处即事实上的表定义）。

写入用 FileDocument 严格校验；查询投影只取部分字段时用对应的 *View 模型，
它们同样继承 MongoDocument，所以缺字段/历史脏数据不会让读接口崩。
"""
from datetime import datetime
from typing import Literal

from pydantic import Field

from ..core.models import MongoDocument

FileType = Literal["pdf", "docx"]
UploadType = Literal["UD", "UB"]  # UD=知识库 / UB=对话框
WikiStatus = Literal["none", "pending", "processing", "completed", "failed"]


class FileDocument(MongoDocument):
    """完整文档：上传时写入 MongoDB 的那份记录（只存文本，不存原始二进制）。"""

    userId: str  # 归属用户，JWT payload 里的 token（字符串形式）
    fileName: str
    filePath: str = ""  # 预留字段，当前上传流程不落盘
    fileType: FileType
    fileSize: int = Field(ge=0, description="字节数")
    fileText: str = ""  # PDF/DOCX 解析并合并后的全文
    uploadType: UploadType
    wikiStatus: WikiStatus = "none"
    wikiChunkCount: int = Field(default=0, ge=0)
    createdAt: datetime = Field(default_factory=datetime.now)
    updatedAt: datetime = Field(default_factory=datetime.now)


class FileListItem(MongoDocument):
    """kbfilelist 接口的投影字段。"""

    fileName: str
    fileSize: int | None = None
    fileType: str | None = None
    wikiStatus: str = "none"


class FileContent(MongoDocument):
    """按 id 取单个文件详情的投影字段（含全文）。"""

    fileName: str
    fileText: str = ""
    fileType: str | None = None
    fileSize: int | None = None
    uploadType: str | None = None


class FileChunkSource(MongoDocument):
    """对话时按 docId 批量取回的文件正文（query_files_by_ids 的投影）。"""

    fileName: str = ""
    fileText: str = ""
    fileSize: int | None = None
    fileType: str | None = None


class FileRef(MongoDocument):
    """归属校验只需要 userId / uploadType 两个字段。"""

    userId: str = ""
    uploadType: str = ""
