"""PDF / DOCX 文本解析。

NestJS 版通过 LangChain PDFLoader（pdf-parse）/ DocxLoader（mammoth）实现，
这里用 pypdf / python-docx 提供等效的纯文本抽取。
"""
import io

from pypdf import PdfReader


def parse_pdf(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data))
    parts: list[str] = []
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        parts.append(text)
    # 与 NestJS 版 mergeTexts 行为一致：每页文本后补换行
    return "".join(p + "\n" for p in parts)


def parse_docx(data: bytes) -> str:
    import docx

    document = docx.Document(io.BytesIO(data))
    # mammoth extract_raw_text 以空行分隔段落
    return "\n\n".join(p.text for p in document.paragraphs if p.text.strip())


def parse_file(data: bytes, file_type: str) -> str:
    if file_type == "pdf":
        return parse_pdf(data)
    return parse_docx(data)
