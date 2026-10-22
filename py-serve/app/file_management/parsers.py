"""PDF / DOCX 文本解析。

NestJS 版通过 LangChain PDFLoader（pdf-parse）/ DocxLoader（mammoth）实现，
这里用 pypdf / python-docx 提供等效的纯文本抽取。

表格处理：
  - DOCX：python-docx 的 document.paragraphs 不包含表格，原实现会让表格 100% 丢失；
    改为按 body 原始顺序遍历段落与表格，表格转 markdown，保持阅读顺序。
  - PDF：**仍用 pypdf 纯文本抽取，不做表格结构化**。曾尝试用 pdfplumber 把表格
    转 markdown，实测在双栏论文上其 extract_text 会按 top→x 排序把左右两栏的
    文字逐行交错拼接（如 "fuse the left" 后直接接另一栏的 "dings (Kiros et al.)"），
    破坏语义连贯性，导致 chunk 级召回全面退化（Recall@5 66.9% → 48.5%，
    10 篇论文无一篇幸免）。该方案已废弃，详见 eval/README.md 的实验记录。
"""
import io

from pypdf import PdfReader


def _rows_to_markdown(rows: list[list]) -> str:
    """二维单元格文本 → markdown 表格；列数按最宽行对齐，空行丢弃。"""
    cleaned = [
        [(cell or "").replace("\n", " ").strip() for cell in row]
        for row in rows
        if row and any((cell or "").strip() for cell in row)
    ]
    if not cleaned:
        return ""
    width = max(len(row) for row in cleaned)
    cleaned = [row + [""] * (width - len(row)) for row in cleaned]

    header = cleaned[0]
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join("---" for _ in header) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in cleaned[1:])
    return "\n".join(lines)


def parse_pdf_with_pages(data: bytes) -> tuple[str, list[int]]:
    """抽取全文，同时返回每页起始字符偏移（用于把 chunk 映射回页码）。"""
    reader = PdfReader(io.BytesIO(data))
    parts: list[str] = []
    page_starts: list[int] = []
    offset = 0
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        page_starts.append(offset)
        part = text + "\n"  # 与 NestJS 版 mergeTexts 行为一致：每页文本后补换行
        parts.append(part)
        offset += len(part)
    return "".join(parts), page_starts


def parse_pdf(data: bytes) -> str:
    return parse_pdf_with_pages(data)[0]


def parse_docx(data: bytes) -> str:
    import docx
    from docx.oxml.ns import qn
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    document = docx.Document(io.BytesIO(data))
    blocks: list[str] = []

    # 逐个子元素遍历 body，才能让表格出现在它原本的位置
    for child in document.element.body.iterchildren():
        if child.tag == qn("w:p"):
            text = Paragraph(child, document).text.strip()
            if text:
                blocks.append(text)
        elif child.tag == qn("w:tbl"):
            markdown = _rows_to_markdown(
                [[cell.text for cell in row.cells] for row in Table(child, document).rows]
            )
            if markdown:
                blocks.append(markdown)

    # mammoth extract_raw_text 以空行分隔段落
    return "\n\n".join(blocks)


def parse_file_with_pages(data: bytes, file_type: str) -> tuple[str, list[int]]:
    """返回 (全文, 每页起始偏移)；DOCX 无稳定页码，偏移列表为空。"""
    if file_type == "pdf":
        return parse_pdf_with_pages(data)
    return parse_docx(data), []


def parse_file(data: bytes, file_type: str) -> str:
    return parse_file_with_pages(data, file_type)[0]
