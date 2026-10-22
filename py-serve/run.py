"""启动脚本：python run.py（默认端口 3000，与 NestJS 版一致）。"""
import uvicorn

from app.core.config import Config

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=Config.PORT,
        log_level="info",
    )
