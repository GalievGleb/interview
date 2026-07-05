from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.models import Document
from app.db.session import get_db
from app.services import candidate_profile, rag_service

router = APIRouter(prefix="/documents", tags=["documents"])

_VALID_KINDS = {"resume", "legend", "vacancy", "company", "notes", "qa"}

# Kinds that feed the candidate profile pack (see services/candidate_profile).
_PROFILE_KINDS = {"resume", "legend", "vacancy"}


class DocumentOut(BaseModel):
    id: str
    kind: str
    title: str
    chunks: int


@router.post("/upload", response_model=DocumentOut)
async def upload(
    background: BackgroundTasks,
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
        raise AppError(str(exc), 400, "parse_error") from exc

    if not text.strip():
        raise AppError("Could not extract text from file", 400, "empty_document")

    doc = Document(kind=kind, title=title or file.filename or kind, raw_text=text)
    db.add(doc)
    db.commit()
    db.refresh(doc)

    chunks = await rag_service.index_document(db, doc)
    if kind in _PROFILE_KINDS:
        background.add_task(candidate_profile.refresh_profile_pack_background)
    return DocumentOut(id=doc.id, kind=doc.kind, title=doc.title, chunks=chunks)


class TextPayload(BaseModel):
    kind: str
    title: str
    text: str


@router.post("/text", response_model=DocumentOut)
async def upload_text(
    payload: TextPayload, background: BackgroundTasks, db: Session = Depends(get_db)
) -> DocumentOut:
    if payload.kind not in _VALID_KINDS:
        raise AppError(f"Invalid kind. Use one of {_VALID_KINDS}", 400, "invalid_kind")
    if not payload.text.strip():
        raise AppError("Text is empty", 400, "empty_document")

    doc = Document(kind=payload.kind, title=payload.title, raw_text=payload.text)
    db.add(doc)
    db.commit()
    db.refresh(doc)

    chunks = await rag_service.index_document(db, doc)
    if payload.kind in _PROFILE_KINDS:
        background.add_task(candidate_profile.refresh_profile_pack_background)
    return DocumentOut(id=doc.id, kind=doc.kind, title=doc.title, chunks=chunks)


@router.get("/profile-pack/status")
def profile_pack_status(db: Session = Depends(get_db)) -> dict:
    """Состояние профиль-пака кандидата (есть ли, не устарел ли)."""
    return candidate_profile.pack_status(db)


@router.post("/profile-pack/refresh")
async def profile_pack_refresh(db: Session = Depends(get_db)) -> dict:
    """Пересобрать профиль-пак из текущих документов (ручной триггер)."""
    return await candidate_profile.refresh_profile_pack(db, force=True)


@router.get("/profile-pack")
def profile_pack_get(db: Session = Depends(get_db)) -> dict:
    """Содержимое пака для UI — пользователь видит, чем live будет отвечать."""
    return {"content": candidate_profile.get_pack_content(db), **candidate_profile.pack_status(db)}


class ProfilePackPayload(BaseModel):
    content: str


@router.put("/profile-pack")
def profile_pack_put(payload: ProfilePackPayload, db: Session = Depends(get_db)) -> dict:
    """Ручная правка пака: правки не затираются фоновой регенерацией."""
    if len(payload.content.strip()) < 20:
        raise AppError("Профиль слишком короткий — минимум пара предложений", 400, "pack_too_short")
    return candidate_profile.save_user_pack(db, payload.content)


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


@router.get("/{document_id}")
def get_document(document_id: str, db: Session = Depends(get_db)) -> dict:
    doc = db.query(Document).filter(Document.id == document_id).first()
    if not doc:
        raise AppError("Document not found", 404, "not_found")
    return {"id": doc.id, "kind": doc.kind, "title": doc.title, "text": doc.raw_text or ""}


@router.delete("/{document_id}")
def delete_document(
    document_id: str, background: BackgroundTasks, db: Session = Depends(get_db)
) -> dict:
    doc = db.query(Document).filter(Document.id == document_id).first()
    if not doc:
        raise AppError("Document not found", 404, "not_found")
    kind = doc.kind
    db.delete(doc)
    db.commit()
    if kind in _PROFILE_KINDS:
        background.add_task(candidate_profile.refresh_profile_pack_background)
    return {"deleted": document_id}
