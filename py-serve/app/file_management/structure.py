"""论文结构识别与切片溯源。

学术论文的版式相对固定（Abstract / Introduction / Method / Experiments / Conclusion…），
章节标题、页码、段落位置因此可以作为稳定的「出处锚点」：
  - 切分时按一级章节断开，避免一个 chunk 横跨「方法」和「实验」两章；
  - 每个 chunk 记录章节路径、起始页、段序与字符区间，回答里才能给出可核对的出处。

识别保持保守：只有明确的编号标题、常见章节名或标题式大小写才认作标题，
识别不到时退化为整篇切分，切分结果与改造前完全一致（不影响召回行为）。
"""
from __future__ import annotations

import bisect
import re
from dataclasses import dataclass, replace

from .splitter import recursive_character_split

_HEADING_MAX_LINE = 90
_HEADING_MAX_TITLE = 60
_MAX_SECTIONS = 80  # 超过这个数量基本是把正文误判成标题了
_MIN_SECTION_CHARS = 150  # 平均章节长度过短同样视为误判
_MAX_PARAGRAPH_CHARS = 1200  # 单段长于此说明空行切段不可靠

# 无编号的常见章节名（小写匹配），命中即视为一级标题
_CANONICAL_HEADINGS = {
    "abstract", "introduction", "related work", "related works", "background",
    "preliminaries", "method", "methods", "methodology", "approach", "proposed method",
    "model", "system model", "experiments", "experiment", "experimental setup",
    "experiments and results", "results", "results and discussion", "evaluation",
    "discussion", "conclusion", "conclusions", "future work", "references",
    "bibliography", "acknowledgements", "acknowledgments", "appendix",
    "摘要", "引言", "绪论", "相关工作", "背景", "方法", "实验", "结果", "讨论",
    "结论", "参考文献", "致谢", "附录",
}
_REFERENCE_TITLES = {"references", "bibliography", "参考文献"}

# 英文标题里可以小写的虚词
_STOP_WORDS = {
    "of", "and", "the", "for", "to", "in", "on", "with", "a", "an", "via", "using",
    "from", "by", "at", "as", "or", "under", "over", "into", "towards", "toward",
}
# 正文句子常见的开头，用来排除「1. We propose ...」这类编号列表
_SENTENCE_STARTERS = {
    "we", "this", "these", "our", "it", "they", "however", "therefore", "thus",
    "moreover", "such", "there", "here", "note",
}

_PARAGRAPH_RE = re.compile(r"[^\s](?:[^\n]|\n(?!\s*\n))*")


@dataclass(frozen=True)
class Section:
    """文中的一个章节区间；path 是从一级标题到当前标题的路径。"""

    title: str
    level: int
    start: int
    end: int
    path: tuple[str, ...]


@dataclass(frozen=True)
class ChunkSpan:
    """一个切片及其出处信息，char_start/char_end 是全文中的绝对字符偏移。"""

    text: str
    char_start: int
    char_end: int
    section: str
    page: int
    para: int  # 章节内段序（1 起）；段落切分不可靠时为 0
    chunk_index: int
    parent_suffix: str = "s0"  # 所属章节在文档内的序号，与 DocSection 对应

    def to_meta(self, doc_id: str) -> dict:
        """转成 Milvus 标量字段；chunkKey 在单篇文档内唯一。"""
        return {
            "chunkKey": f"{doc_id}#{self.chunk_index}",
            "chunkIndex": self.chunk_index,
            "parentId": f"{doc_id}#{self.parent_suffix}",
            "section": self.section[:500],
            "page": self.page,
            "para": self.para,
            "charStart": self.char_start,
            "charEnd": self.char_end,
        }


@dataclass(frozen=True)
class DocSection:
    """父文档：一个章节区间，子块命中后可回表取它补全上下文。"""

    parent_suffix: str
    title: str
    level: int
    path: tuple[str, ...]
    start: int
    end: int
    page_start: int
    page_end: int
    text: str

    def to_mongo(self, doc_id: str, user_id: str, doc_title: str) -> dict:
        return {
            "userId": user_id,
            "docId": doc_id,
            "docTitle": doc_title,
            "parentId": f"{doc_id}#{self.parent_suffix}",
            "path": " > ".join(self.path),
            "level": self.level,
            "start": self.start,
            "end": self.end,
            "pageStart": self.page_start,
            "pageEnd": self.page_end,
            "text": self.text,
        }


def detect_sections(text: str) -> list[Section]:
    """按行扫描标题，返回按位置排序的章节区间；识别不到时返回整篇「正文」。"""
    if not text:
        return []

    headings: list[tuple[int, int, str]] = []  # (start, level, title)
    offset = 0
    for raw_line in text.splitlines(keepends=True):
        line_start = offset + (len(raw_line) - len(raw_line.lstrip()))
        offset += len(raw_line)
        line = raw_line.strip()
        matched = _match_heading(line)
        if not matched:
            continue
        level, title = matched
        headings.append((line_start, level, title))
        # 参考文献之后基本都是条目，继续识别只会产生大量伪章节
        if title.strip().rstrip(".").lower() in _REFERENCE_TITLES:
            break

    if not headings:
        return [Section("正文", 0, 0, len(text), ("正文",))]

    sections: list[Section] = []
    stack: list[tuple[int, str]] = []
    for index, (start, level, title) in enumerate(headings):
        end = headings[index + 1][0] if index + 1 < len(headings) else len(text)
        if end <= start:
            continue
        while stack and stack[-1][0] >= level:
            stack.pop()
        path = tuple(item[1] for item in stack) + (title,)
        sections.append(Section(title, level, start, end, path))
        stack.append((level, title))

    if not sections:
        return [Section("正文", 0, 0, len(text), ("正文",))]
    if sections[0].start > 0:
        sections.insert(0, Section("正文", 0, 0, sections[0].start, ("正文",)))
    return sections


def resolve_sections(text: str) -> list[Section]:
    """章节识别 + 可信度兜底：识别失败时整篇视为一个「正文」父文档。"""
    if not text or not text.strip():
        return []
    sections = detect_sections(text)
    if not _sections_trustworthy(text, sections):
        return [Section("正文", 0, 0, len(text), ("正文",))]
    return sections


def split_document(
    text: str,
    page_starts: list[int] | None = None,
    chunk_size: int = 800,
    chunk_overlap: int = 100,
) -> list[ChunkSpan]:
    """结构感知切分（只要子块）：章节内切块 + 每块回填章节/页码/段序/字符区间。"""
    return split_document_with_sections(text, page_starts, chunk_size, chunk_overlap)[0]


def split_document_with_sections(
    text: str,
    page_starts: list[int] | None = None,
    chunk_size: int = 800,
    chunk_overlap: int = 100,
) -> tuple[list[ChunkSpan], list[DocSection]]:
    """一次切分同时产出子块与父文档（一级章节），两者通过 parent_suffix 对应。"""
    sections = resolve_sections(text)
    if not sections:
        return [], []

    groups, group_of_section = _group_by_chapter(sections)
    doc_sections = [
        DocSection(
            parent_suffix=f"s{index}",
            title=group.title,
            level=group.level,
            path=group.path,
            start=group.start,
            end=group.end,
            page_start=_page_at(page_starts, group.start),
            page_end=_page_at(page_starts, max(group.end - 1, group.start)),
            text=text[group.start:group.end],
        )
        for index, group in enumerate(groups)
    ]
    return (
        _split_with_sections(
            text, sections, groups, group_of_section, page_starts, chunk_size, chunk_overlap
        ),
        doc_sections,
    )


def _split_with_sections(
    text: str,
    sections: list[Section],
    groups: list[Section],
    group_of_section: list[int],
    page_starts: list[int] | None,
    chunk_size: int,
    chunk_overlap: int,
) -> list[ChunkSpan]:
    paragraphs = _paragraph_spans(text)
    para_starts = [p[0] for p in paragraphs]
    section_starts = [s.start for s in sections]
    section_para_ranges = []
    for section in sections:
        lo = bisect.bisect_left(para_starts, section.start)
        hi = bisect.bisect_left(para_starts, section.end)
        # 标题行本身也是一段，排除掉之后「第 N 段」才是正文段序
        if lo < len(paragraphs):
            head = text[paragraphs[lo][0]:paragraphs[lo][1]].strip()
            if _is_heading_only(head, section.title):
                lo += 1
        count = max(hi - lo, 0)
        # 单段且极长 = 空行切段失效（部分 PDF 抽不出段间空行），这时不报段序
        reliable = count >= 2 or (
            count == 1 and paragraphs[lo][1] - paragraphs[lo][0] <= _MAX_PARAGRAPH_CHARS
        )
        section_para_ranges.append((lo, count, reliable))

    chunks: list[ChunkSpan] = []
    for group in groups:
        cursor = group.start
        for part in recursive_character_split(text[group.start:group.end], chunk_size, chunk_overlap):
            start = text.find(part, cursor, group.end)
            if start < 0:
                start = text.find(part, group.start, group.end)
            if start < 0:
                # 理论上不会发生（切片是原文子串），保守跳过而不是写错出处
                continue
            end = start + len(part)
            cursor = max(cursor, end)

            section_index = max(bisect.bisect_right(section_starts, start) - 1, 0)
            section = sections[section_index]
            # 长段落会让标题行被单独切成一块：这不是有效内容，丢掉而不是入库
            if _is_heading_only(part.strip(), section.title):
                continue
            para_lo, para_count, para_reliable = section_para_ranges[section_index]
            para = 0
            if para_reliable:
                global_para = max(bisect.bisect_right(para_starts, start) - 1, 0)
                para = min(max(global_para - para_lo + 1, 1), para_count)

            chunks.append(
                ChunkSpan(
                    text=part,
                    char_start=start,
                    char_end=end,
                    section=" > ".join(sections[section_index].path),
                    page=_page_at(page_starts, start),
                    para=para,
                    chunk_index=len(chunks),
                    parent_suffix=f"s{group_of_section[section_index]}",
                )
            )
    return chunks


def _match_heading(line: str) -> tuple[int, str] | None:
    """识别标题行，返回 (层级, 标题)；不是标题返回 None。"""
    if not line or len(line) > _HEADING_MAX_LINE:
        return None
    if line[-1] in "。，；：、,;:":
        return None
    if line[0] in "-•·*" or "|" in line:
        return None
    # 目录行：大量点线或行尾页码
    if re.search(r"\.{3,}|…{2,}", line) or re.search(r"\s\d{1,4}\s*$", line):
        return None

    match = re.match(r"^(?P<num>\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+(?P<title>\S.*)$", line)
    if match:
        title = match.group("title").strip().rstrip(".")
        if _looks_like_title(title):
            return match.group("num").count(".") + 1, title

    match = re.match(r"^(?P<num>[IVX]{1,5})\.\s+(?P<title>\S.*)$", line)
    if match:
        title = match.group("title").strip().rstrip(".")
        if _looks_like_title(title):
            return 1, title

    match = re.match(r"^(?P<num>[一二三四五六七八九十]{1,3})[、.]\s*(?P<title>\S.*)$", line)
    if match:
        title = match.group("title").strip().rstrip("。.")
        if _looks_like_title(title):
            return 1, title

    normalized = line.strip().rstrip(".").strip().lower()
    if normalized in _CANONICAL_HEADINGS:
        return 1, line.strip().rstrip(".")
    return None


def _looks_like_title(title: str) -> bool:
    """标题式大小写启发式：中文标题短即可，英文要求大部分实词首字母大写。"""
    if not title or len(title) > _HEADING_MAX_TITLE:
        return False
    if title[0].islower():
        return False
    if re.search(r"[。！？!?]", title):
        return False

    if re.search(r"[\u4e00-\u9fff]", title):
        return len(title) <= 30

    words = re.findall(r"[A-Za-z][A-Za-z\-]*", title)
    if not words or len(words) > 8:
        return False
    if title.isupper():
        return True
    if words[0].lower() in _SENTENCE_STARTERS and len(words) > 2:
        return False

    significant = [word for word in words if word.lower() not in _STOP_WORDS]
    if not significant:
        return False
    capitalized = sum(1 for word in significant if word[0].isupper())
    return capitalized / len(significant) >= 0.6


def _sections_trustworthy(text: str, sections: list[Section]) -> bool:
    if len(sections) <= 1:
        return True
    if len(sections) > _MAX_SECTIONS:
        return False
    return len(text) / len(sections) >= _MIN_SECTION_CHARS


def _group_by_chapter(sections: list[Section]) -> tuple[list[Section], list[int]]:
    """把二三级标题并进所属一级章节：只在章与章之间断开，避免切出大量碎片。

    返回 (groups, group_of_section)：后者记录每个原始 section 归属哪个一级章节，
    子块的 parentId 指向一级章节，避免把「只有 10 个字的空小节」当父文档。
    """
    groups: list[Section] = []
    group_of_section: list[int] = []
    for section in sections:
        if not groups:
            groups.append(section)
            group_of_section.append(0)
            continue
        last = groups[-1]
        same_repeated_heading = section.level == last.level and section.title == last.title
        if section.level > 1 or same_repeated_heading:
            groups[-1] = replace(last, end=section.end)
            group_of_section.append(len(groups) - 1)
        else:
            groups.append(section)
            group_of_section.append(len(groups) - 1)
    return groups, group_of_section


def _is_heading_only(text: str, title: str) -> bool:
    """判断切片是否只剩标题行（可能带「1.」「三、」这类编号）。"""
    if len(text) >= 60:
        return False
    title = title.strip()
    if text == title:
        return True
    if not title or not text.endswith(title):
        return False
    prefix = text[: len(text) - len(title)]
    return bool(re.fullmatch(r"[\dIVXivx一二三四五六七八九十.\s、]+", prefix))


def _paragraph_spans(text: str) -> list[tuple[int, int]]:
    """按空行切段；PDF 抽出的文本即使没有空行，也会退化成整段（段序置 0）。"""
    return [(match.start(), match.end()) for match in _PARAGRAPH_RE.finditer(text)]


def _page_at(page_starts: list[int] | None, offset: int) -> int:
    """字符偏移 → 页码（1 起）；DOCX 没有页概念时返回 0。"""
    if not page_starts:
        return 0
    return bisect.bisect_right(page_starts, offset)
