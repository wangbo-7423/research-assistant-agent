"""Python 版后端入口（FastAPI），照 NestJS 版 main.ts 组织：

- CORS 全开（对应 NestFactory cors: true）
- /open-image 静态目录（对应 express.static(uploads-image)）
- 统一响应包装 + 全局异常过滤器
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .chat.router import router as chat_router
from .core.response import register_exception_handlers
from .file_management.image_storage import ensure_image_upload_dir
from .file_management.router import router as file_management_router
from .userinfo.router import router as userinfo_router

app = FastAPI(title="research-assistant-agent py-serve")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

register_exception_handlers(app)

app.include_router(userinfo_router)
app.include_router(file_management_router)
app.include_router(chat_router)

# 静态图片目录：/open-image/* -> uploads-image/*
ensure_image_upload_dir()
app.mount(
    "/open-image",
    StaticFiles(directory=str(Path(__file__).resolve().parent.parent / "uploads-image")),
    name="open-image",
)


@app.get("/health")
async def health():
    return {"status": "ok"}
