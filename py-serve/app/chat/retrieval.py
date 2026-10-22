"""知识库问答（queryKb）：混合检索 → 父章节聚合 → 拼装片段 → 二轮流式回答。

检索侧（向量 + 关键词 RRF 融合）由 file_management.service.hybrid_search 提供，
这里只负责「拿到片段后怎么组织进上下文并流式输出」。

父子结构：子块负责召回，命中后按 parentId 聚合去重，回表取父章节并截取
「子块 ± 上下文窗口」注入模型（有界展开，避免整章挤爆上下文，也保证引用覆盖注入内容）。
"""
import traceback

from pymongo.asynchronous.collection import AsyncCollection

from ..file_management.sections import get_sections_by_ids
from ..file_management.service import hybrid_search
from .llm import calling_model
from .stream import StreamWriter

_CITATION_SNIPPET_CHARS = 160
_PARENT_WINDOW_CHARS = 600  # 子块左右各扩多少字作为上下文
_FRAGMENT_MAX_CHARS = 2400  # 单个片段上限，防止整章塞进 prompt


def _fragment_header(index: int, fragment: dict) -> str:
    """片段头：编号 + 文档名 + 章节 + 页码，模型据此知道每段出处。"""
    parts = [f"片段{index}", str(fragment.get("docTitle") or "未知文档")]
    section = (fragment.get("section") or "").strip()
    if section:
        parts.append(section)
    page = int(fragment.get("page") or 0)
    if page:
        parts.append(f"第{page}页")
    return "【" + "·".join(parts) + "】"


def _cluster_by_parent(hits: list[dict]) -> list[list[dict]]:
    """同一父章节的命中合并成一组：父上下文只注入一次，避免重复占用窗口。"""
    groups: dict[str, list[dict]] = {}
    order: list[str] = []
    for hit in hits:
        key = (
            hit.get("parentId")
            or hit.get("chunkKey")
            or f"{hit.get('docId')}::{(hit.get('docText') or '')[:50]}"
        )
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(hit)
    return [groups[key] for key in order]


def _build_fragments(hits: list[dict], parents: dict[str, dict]) -> list[dict]:
    """把命中子块组装成「父章节上下文窗口」片段。

    窗口以排名最高的子块为中心向两侧扩 _PARENT_WINDOW_CHARS，同组其他命中也纳入窗口；
    总长超过 _FRAGMENT_MAX_CHARS 时按中心截断，保证命中文本一定在片段内。
    """
    fragments: list[dict] = []
    for group in _cluster_by_parent(hits):
        rep = group[0]
        text = rep.get("docText") or ""
        char_start = int(rep.get("charStart") or 0)
        char_end = int(rep.get("charEnd") or 0)
        parent = parents.get(rep.get("parentId") or "")

        if parent and parent.get("text") and char_end > char_start:
            p_start = int(parent.get("start") or 0)
            p_end = int(parent.get("end") or 0)
            p_text = parent["text"]
            start = max(p_start, char_start - _PARENT_WINDOW_CHARS)
            end = min(p_end, char_end + _PARENT_WINDOW_CHARS)
            for other in group[1:]:
                other_start = int(other.get("charStart") or 0)
                other_end = int(other.get("charEnd") or 0)
                if other_end > other_start:
                    start = min(start, max(p_start, other_start - _PARENT_WINDOW_CHARS))
                    end = max(end, min(p_end, other_end + _PARENT_WINDOW_CHARS))
            if end - start > _FRAGMENT_MAX_CHARS:
                start = max(p_start, char_start - _PARENT_WINDOW_CHARS)
                end = min(p_end, start + _FRAGMENT_MAX_CHARS)
            window = p_text[start - p_start:end - p_start]
            if window.strip():
                text, char_start, char_end = window, start, end

        fragments.append(
            {
                "docId": rep.get("docId") or "",
                "docTitle": rep.get("docTitle") or "",
                "section": rep.get("section") or "",
                "page": int(rep.get("page") or 0),
                "para": int(rep.get("para") or 0),
                "parentId": rep.get("parentId") or "",
                "chunkKey": rep.get("chunkKey") or "",
                "charStart": char_start,
                "charEnd": char_end,
                "text": text,
                "hits": group,
            }
        )
    return fragments


def _build_citations(fragments: list[dict]) -> list[dict]:
    """出处列表：index 与回答里的 [N] 一一对应。

    snippet 只做卡片预览，text 是模型实际看到的完整片段，前端可展开核对。
    """
    citations: list[dict] = []
    for index, fragment in enumerate(fragments, 1):
        raw_text = fragment.get("text") or ""
        flat = " ".join(raw_text.split())
        snippet = flat[:_CITATION_SNIPPET_CHARS]
        if len(flat) > _CITATION_SNIPPET_CHARS:
            snippet += "…"
        hits = fragment.get("hits") or []
        citations.append(
            {
                "index": index,
                "docId": fragment.get("docId") or "",
                "docTitle": fragment.get("docTitle") or "",
                "section": fragment.get("section") or "",
                "page": int(fragment.get("page") or 0),
                "para": int(fragment.get("para") or 0),
                "parentId": fragment.get("parentId") or "",
                "chunkKey": fragment.get("chunkKey") or "",
                "charStart": int(fragment.get("charStart") or 0),
                "charEnd": int(fragment.get("charEnd") or 0),
                "snippet": snippet,
                "text": raw_text,
                "score": round(max(float(h.get("rrfScore") or 0) for h in hits) if hits else 0, 6),
                "matchedBy": [
                    name
                    for name, flag in (("vector", "hitVector"), ("keyword", "hitKeyword"))
                    if any(h.get(flag) for h in hits)
                ],
            }
        )
    return citations


async def query_kb(
    write: StreamWriter,
    user_question: str,
    message_list: list[dict],
    user_id: str,
    read_file_list: dict | None,
    sections_col: AsyncCollection,
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
        # 2. 按父章节聚合 + 回表取章节文本，组装成有界上下文片段
        parents = await get_sections_by_ids(
            sections_col, user_id, [h.get("parentId") for h in hits if h.get("parentId")]
        )
        fragments = _build_fragments(hits, parents)
        citations = _build_citations(fragments)

        # 3. 告知前端检索完成、命中的文件与出处（citations 与回答里的 [N] 对应）
        hit_file_names = list(
            dict.fromkeys(f.get("docTitle") for f in fragments if f.get("docTitle"))
        )
        kb_read_file_data = {
            "type": "queryKB",
            "statusInfo": "completed",
            "promptInfo": "知识库检索完成" if fragments else "知识库未检索到相关内容",
            "fileList": hit_file_names,
        }
        await write.notify({**kb_read_file_data, "citations": citations})

        # 4. 拼接检索结果；无命中时使用约定占位符，交给系统提示词规则处理
        kb_content = (
            "\n\n".join(
                f"{_fragment_header(i, fragment)}\n{fragment.get('text')}"
                for i, fragment in enumerate(fragments, 1)
            )
            if fragments
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
        return {
            "role": "assistant",
            "content": answer_content,
            "readFileData": kb_read_file_data,
            "citations": citations,
        }
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
