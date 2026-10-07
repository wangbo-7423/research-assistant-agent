"""递归字符文本切片器，对齐 LangChain RecursiveCharacterTextSplitter
（chunkSize=800, chunkOverlap=100，默认分隔符 \\n\\n / \\n / 空格 / 空）。
"""
from typing import List


def _split_on_separator(text: str, separator: str) -> List[str]:
    if separator == "":
        return list(text)
    splits = text.split(separator)
    # LangChain 行为：分隔符保留在每段末尾
    return [s + separator for s in splits[:-1]] + ([splits[-1]] if splits[-1] else [])


def _merge_splits(splits: List[str], chunk_size: int, chunk_overlap: int) -> List[str]:
    docs: List[str] = []
    current: List[str] = []
    total = 0
    for d in splits:
        length = len(d)
        if total + length > chunk_size and current:
            doc = "".join(current)
            if doc.strip():
                docs.append(doc)
            # 回退构造 overlap
            while total > chunk_overlap or (total + length > chunk_size and total > 0):
                total -= len(current[0])
                current.pop(0)
        current.append(d)
        total += length
    doc = "".join(current)
    if doc.strip():
        docs.append(doc)
    return docs


def recursive_character_split(
    text: str,
    chunk_size: int = 800,
    chunk_overlap: int = 100,
    separators: tuple = ("\n\n", "\n", " ", ""),
) -> List[str]:
    if not text:
        return []
    final_chunks: List[str] = []
    separator = separators[0] if separators else ""
    next_separators = separators[1:] if len(separators) > 1 else ()
    splits = _split_on_separator(text, separator)
    good_splits: List[str] = []
    for s in splits:
        if len(s) < chunk_size:
            good_splits.append(s)
            continue
        if good_splits:
            final_chunks.extend(_merge_splits(good_splits, chunk_size, chunk_overlap))
            good_splits = []
        if not next_separators:
            if s.strip():
                final_chunks.append(s)
        else:
            final_chunks.extend(recursive_character_split(s, chunk_size, chunk_overlap, next_separators))
    if good_splits:
        final_chunks.extend(_merge_splits(good_splits, chunk_size, chunk_overlap))
    return [c for c in (chunk.strip() if chunk.strip() else "" for chunk in final_chunks) if c]
