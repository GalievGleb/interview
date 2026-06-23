import io
import json
import logging
import math

from sqlalchemy.orm import Session

from app.db.models import DocChunk, Document
from app.services import provider_adapter

logger = logging.getLogger("rag")

CHUNK_SIZE = 800
CHUNK_OVERLAP = 120


def parse_file(filename: str, content: bytes) -> str:
    name = filename.lower()
    if name.endswith(".pdf"):
        return _parse_pdf(content)
    if name.endswith(".docx"):
        return _parse_docx(content)
    if name.endswith((".txt", ".md")):
        return content.decode("utf-8", errors="ignore")
    raise ValueError("Unsupported file type. Use PDF, DOCX, TXT or MD.")


def _parse_pdf(content: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(content))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def _parse_docx(content: bytes) -> str:
    import docx

    doc = docx.Document(io.BytesIO(content))
    return "\n".join(p.text for p in doc.paragraphs)


def chunk_text(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        chunks.append(text[start:end])
        start = end - CHUNK_OVERLAP
        if start < 0:
            start = 0
    return chunks


async def index_document(db: Session, document: Document) -> int:
    chunks = chunk_text(document.raw_text)
    if not chunks:
        return 0

    embeddings: list[list[float] | None]
    try:
        embeddings = await provider_adapter.embed(chunks)  # type: ignore[assignment]
    except Exception as exc:
        logger.warning("Embedding failed, storing chunks without vectors: %s", exc)
        embeddings = [None] * len(chunks)

    for i, chunk in enumerate(chunks):
        emb = embeddings[i] if i < len(embeddings) else None
        db.add(
            DocChunk(
                document_id=document.id,
                chunk_index=i,
                text=chunk,
                embedding=json.dumps(emb) if emb else None,
            )
        )
    db.commit()
    return len(chunks)


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


async def search(db: Session, query: str, kinds: list[str] | None = None, top_k: int = 5) -> list[dict]:
    q = db.query(DocChunk).join(Document)
    if kinds:
        q = q.filter(Document.kind.in_(kinds))
    rows = q.all()
    if not rows:
        return []

    try:
        query_emb = (await provider_adapter.embed([query]))[0]
    except Exception as exc:
        logger.warning("Query embedding failed, falling back to keyword match: %s", exc)
        return _keyword_search(rows, query, top_k)

    scored: list[tuple[float, DocChunk]] = []
    for row in rows:
        if not row.embedding:
            continue
        emb = json.loads(row.embedding)
        scored.append((_cosine(query_emb, emb), row))

    if not scored:
        return _keyword_search(rows, query, top_k)

    scored.sort(key=lambda x: x[0], reverse=True)
    return [
        {"text": row.text, "score": round(score, 4), "document_id": row.document_id}
        for score, row in scored[:top_k]
    ]


def _keyword_search(rows: list[DocChunk], query: str, top_k: int) -> list[dict]:
    terms = [t for t in query.lower().split() if len(t) > 2]
    scored = []
    for row in rows:
        text_low = row.text.lower()
        score = sum(text_low.count(t) for t in terms)
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [
        {"text": row.text, "score": float(score), "document_id": row.document_id}
        for score, row in scored[:top_k]
    ]


def get_context_text(db: Session, kind: str) -> str:
    """Полный текст последнего документа заданного типа (resume/vacancy)."""
    doc = (
        db.query(Document)
        .filter(Document.kind == kind)
        .order_by(Document.created_at.desc())
        .first()
    )
    return doc.raw_text if doc else ""
