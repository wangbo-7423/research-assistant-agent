"""SSE 流式输出：用 asyncio.Queue 模拟 Express 的 res.write / res.end。

生产端（对话任务）调 notify / end 写入队列，消费端（StreamingResponse）从 stream 读取，
两边通过队列解耦，避免把生成逻辑和 HTTP 响应绑在一起。
"""
import asyncio
import json


class StreamWriter:
    """按 SSE 帧格式（`data: <json>\\n\\n`）输出。"""

    def __init__(self):
        self.queue: asyncio.Queue = asyncio.Queue()
        self._closed = False

    async def notify(self, stream_data: dict) -> None:
        if self._closed:
            return
        # SSE 帧：data: <json>\n\n
        # json.dumps 会把内容中的换行转义成字面 \n，因此单帧必然是单行，天然满足 SSE 规范，
        # 不需要像普通文本那样处理多行 data 的合并。
        await self.queue.put(f"data: {json.dumps(stream_data, ensure_ascii=False)}\n\n")

    async def end(self) -> None:
        if not self._closed:
            self._closed = True
            await self.queue.put(None)

    async def stream(self):
        while True:
            item = await self.queue.get()
            if item is None:
                break
            yield item
