"""知识库问答（queryKb）：混合检索 → 拼装片段 → 二轮流式回答。

检索侧（向量 + 关键词 RRF 融合）由 file_management.service.hybrid_search 提供，
这里只负责「拿到片段后怎么组织进上下文并流式输出」。
"""
import traceback

from ..file_management.service import hybrid_search
from .llm import calling_model
from .stream import StreamWriter


async def query_kb(
    write: StreamWriter,
    user_question: str,
    message_list: list[dict],
    user_id: str,
    read_file_list: dict | None,
) -> dict | None:
    """根据用户问题，检索知识库并回答（返回助手完整回复，用于持久化；失败返回 None）。"""
    await write.notify(
        {"type": "queryKB", "statusInfo": "inProgress", "promptInfo": "正在检索知识库", "fileList": []}
    )
    answer_content = ""
    kb_read_file_data: dict | None = None
    try:
        # 1. 混合检索：对用户问题 embedding + 向量检索 + 关键词检索 + RRF 融合
        search_res = await hybrid_search(user_question, user_id, 5)
        hits = search_res.get("results") or []

        # 2. 告知前端检索完成及命中的文件
        hit_file_names = list(dict.fromkeys(h.get("docTitle") for h in hits if h.get("docTitle")))
        kb_read_file_data = {
            "type": "queryKB",
            "statusInfo": "completed",
            "promptInfo": "知识库检索完成" if hits else "知识库未检索到相关内容",
            "fileList": hit_file_names,
        }
        await write.notify(kb_read_file_data)

        # 3. 拼接检索结果；无命中时使用约定占位符，交给系统提示词规则处理
        kb_content = (
            "\n\n".join(f"【片段{i + 1}·{h.get('docTitle')}】\n{h.get('docText')}" for i, h in enumerate(hits))
            if hits
            else "&没有检索到相关文档&"
        )

        # 4. 组装带知识库上下文的对话并调用模型（流式）
        kb_messages = [
            *message_list[:-1],
            {
                "role": "user",
                "content": f"知识库检索结果如下：\n{kb_content}\n\n请基于上述检索结果回答用户问题：{user_question}",
            },
        ]
        res = await calling_model(kb_messages, False, True)
        async for chunk in res:
            choices = chunk.choices
            if not choices:
                continue
            delta = choices[0].delta
            if delta and delta.content:
                answer_content += delta.content
                await write.notify({"type": "answer", "content": delta.content})

        if not answer_content:
            return None
        return {"role": "assistant", "content": answer_content, "readFileData": kb_read_file_data}
    except Exception:
        print("检索知识库出错")
        traceback.print_exc()
        await write.notify(
            {
                "type": "queryKB",
                "statusInfo": "completed",
                "promptInfo": "知识库检索失败，请稍后重试",
                "fileList": [],
            }
        )
        return None
    finally:
        await write.end()
