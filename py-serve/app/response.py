"""统一响应包装与全局异常处理。

对应 NestJS 版的 TransformInterceptor + HttpExceptionFilter：
- 控制器若返回 {message, data, code?} 自定义结构则解包；
- 否则原样作为 data 包进统一结构；
- 异常统一输出 {statusCode, message, data: null, timestamp, path}。
"""
import traceback
from datetime import datetime, timezone
from typing import Any, cast

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class BizError(Exception):
    """业务异常：携带 HTTP 状态码与消息（对应 NestJS 的 HttpException）。"""

    def __init__(self, message: str, status_code: int = 400):
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def wrap_response(data: Any, path: str) -> JSONResponse:
    """复刻 TransformInterceptor 的包装逻辑。"""
    message = "SUCCESS"
    real_data = data
    status_code = 200
    if data is not None and isinstance(data, dict) and "message" in data and "data" in data:
        message = data.get("message") or "SUCCESS"
        real_data = data.get("data")
        if data.get("code") is not None:
            status_code = int(data["code"])
    return JSONResponse(
        status_code=status_code,
        content={
            "statusCode": status_code,
            "message": message,
            "data": real_data,
            "timestamp": _now_iso(),
            "path": path,
        },
    )


def error_body(status_code: int, message: Any, path: str) -> dict:
    return {
        "statusCode": status_code,
        "message": message,
        "data": None,
        "timestamp": _now_iso(),
        "path": path,
    }


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(BizError)
    async def biz_error_handler(request: Request, exc: BizError):
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(exc.status_code, exc.message, request.url.path),
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        detail = cast(object, exc.detail)
        if isinstance(detail, dict):
            message: object = detail.get("message", detail)
        elif isinstance(detail, str):
            message = detail
        else:
            message = detail or "Internal server error"
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(exc.status_code, message, request.url.path),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        # 与 NestJS ValidationPipe 对齐：400 + message 为错误信息数组
        messages: list[str] = []
        for err in exc.errors():
            loc = ".".join(str(x) for x in err.get("loc", []) if x not in ("body",))
            messages.append(f"{loc}: {err.get('msg')}" if loc else str(err.get("msg")))
        return JSONResponse(
            status_code=400,
            content=error_body(400, messages, request.url.path),
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content=error_body(500, "Internal server error", request.url.path),
        )
