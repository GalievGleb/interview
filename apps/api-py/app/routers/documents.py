from fastapi import APIRouter, Depends, File, Form, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.models import Document
from app.db.session import get_db
from app.services import rag_service

router = APIRouter(prefix="/documents", tags=["documents"])

_VALID_KINDS = {"resume", "vacancy", "company", "notes", "qa"}


class DocumentOut(BaseModel):
    id: str
    kind: str
    title: str
    chunks: int


@router.post("/upload", response_model=DocumentOut)
async def upload(
    file: UploadFile = File(...),
    kind: str = Form(...),
    title: str | None = Form(None),
    db: Session = Depends(get_db),
) -> DocumentOut:
    if kind not in _VALID_KINDS:
        raise AppError(f"Invalid kind. Use one of {_VALID_KINDS}", 400, "invalid_kind")

    content = await file.read()
    try:
        text = rag_service.parse_file(file.filename or "file.txt", content)
    except ValueError as exc:
        raise AppError(str(exc), 400, "parse_error")

    if not text.strip():
        raise AppError("Could not extract text from file", 400, "empty_document")

    doc = Document(kind=kind, title=title or file.filename or kind, raw_text=text)
    db.add(doc)
    db.commit()
    db.refresh(doc)

    chunks = await rag_service.index_document(db, doc)
    return DocumentOut(id=doc.id, kind=doc.kind, title=doc.title, chunks=chunks)


class TextPayload(BaseModel):
    kind: str
    title: str
    text: str


@router.post("/text", response_model=DocumentOut)
async def upload_text(payload: TextPayload, db: Session = Depends(get_db)) -> DocumentOut:
    if payload.kind not in _VALID_KINDS:
        raise AppError(f"Invalid kind. Use one of {_VALID_KINDS}", 400, "invalid_kind")
    if not payload.text.strip():
        raise AppError("Text is empty", 400, "empty_document")

    doc = Document(kind=payload.kind, title=payload.title, raw_text=payload.text)
    db.add(doc)
    db.commit()
    db.refresh(doc)

    chunks = await rag_service.index_document(db, doc)
    return DocumentOut(id=doc.id, kind=doc.kind, title=doc.title, chunks=chunks)


class SearchPayload(BaseModel):
    query: str
    kinds: list[str] | None = None
    top_k: int = 5


@router.post("/search")
async def search(payload: SearchPayload, db: Session = Depends(get_db)) -> dict:
    results = await rag_service.search(db, payload.query, payload.kinds, payload.top_k)
    return {"results": results, "found": len(results) > 0}


@router.get("")
def list_documents(db: Session = Depends(get_db)) -> dict:
    docs = db.query(Document).order_by(Document.created_at.desc()).all()
    return {
        "documents": [
            {"id": d.id, "kind": d.kind, "title": d.title, "created_at": d.created_at.isoformat()}
            for d in docs
        ]
    }


@router.delete("/{document_id}")
def delete_document(document_id: str, db: Session = Depends(get_db)) -> dict:
    doc = db.query(Document).filter(Document.id == document_id).first()
    if not doc:
        raise AppError("Document not found", 404, "not_found")
    db.delete(doc)
    db.commit()
    return {"deleted": document_id}
