import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    # Наивный UTC — как и раньше хранился в БД, но без deprecated utcnow().
    return datetime.now(UTC).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    display_name: Mapped[str | None] = mapped_column(String, nullable=True)
    privacy_mode: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str | None] = mapped_column(String, nullable=True)
    kind: Mapped[str] = mapped_column(String)  # resume | vacancy | company | notes | qa
    title: Mapped[str] = mapped_column(String)
    raw_text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    chunks: Mapped[list["DocChunk"]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )


class DocChunk(Base):
    __tablename__ = "doc_chunks"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    chunk_index: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    embedding: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON-массив

    document: Mapped[Document] = relationship(back_populates="chunks")


class InterviewSession(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str | None] = mapped_column(String, nullable=True)
    mode: Mapped[str] = mapped_column(String)  # interview | meeting
    title: Mapped[str | None] = mapped_column(String, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)

    transcripts: Mapped[list["Transcript"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    answers: Mapped[list["Answer"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    assessment: Mapped["SessionAssessment | None"] = relationship(
        back_populates="session", cascade="all, delete-orphan", uselist=False
    )
    diagnostic: Mapped["SessionDiagnostic | None"] = relationship(
        back_populates="session", cascade="all, delete-orphan", uselist=False
    )


class Transcript(Base):
    __tablename__ = "transcripts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    speaker: Mapped[str] = mapped_column(String, default="unknown")  # me | other
    text: Mapped[str] = mapped_column(Text)
    is_final: Mapped[bool] = mapped_column(Boolean, default=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=_now)

    session: Mapped[InterviewSession] = relationship(back_populates="transcripts")


class SessionAssessment(Base):
    __tablename__ = "session_assessments"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), unique=True, index=True
    )
    language: Mapped[str] = mapped_column(String, default="ru")
    analysis_json: Mapped[str] = mapped_column(Text)
    markdown: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    session: Mapped[InterviewSession] = relationship(back_populates="assessment")


class SessionDiagnostic(Base):
    """Bounded live STT/LLM timeline persisted for one interview session."""

    __tablename__ = "session_diagnostics"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), unique=True, index=True
    )
    payload_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    session: Mapped[InterviewSession] = relationship(back_populates="diagnostic")


class Answer(Base):
    __tablename__ = "answers"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    session_id: Mapped[str | None] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), nullable=True
    )
    question: Mapped[str] = mapped_column(Text)
    answer_short: Mapped[str | None] = mapped_column(Text, nullable=True)
    answer_spoken: Mapped[str | None] = mapped_column(Text, nullable=True)
    answer_detailed: Mapped[str | None] = mapped_column(Text, nullable=True)
    answer_en: Mapped[str | None] = mapped_column(Text, nullable=True)
    risk_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    model: Mapped[str | None] = mapped_column(String, nullable=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=_now)

    session: Mapped[InterviewSession | None] = relationship(back_populates="answers")


class ApiUsage(Base):
    __tablename__ = "api_usage"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str | None] = mapped_column(String, nullable=True)
    provider: Mapped[str] = mapped_column(String)
    kind: Mapped[str] = mapped_column(String)  # chat | stt | embed
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    stt_seconds: Mapped[int] = mapped_column(Integer, default=0)
    ts: Mapped[datetime] = mapped_column(DateTime, default=_now)


class MockSession(Base):
    """Vacancy Smoke Review session — durable home for what used to live only
    in the renderer's localStorage. Payload is the full frontend session JSON
    (schema evolves on the frontend; the backend only keys/sorts it)."""

    __tablename__ = "mock_sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    status: Mapped[str] = mapped_column(String, default="in_progress")
    started_at: Mapped[int] = mapped_column(Integer, default=0)  # epoch ms
    updated_at: Mapped[int] = mapped_column(Integer, default=0)  # epoch ms
    payload: Mapped[str] = mapped_column(Text, default="{}")


class AnswerLatency(Base):
    """Per-answer pipeline timings — powers the p50/p95 latency trend and the
    latency budget check on the Diagnostics screen."""

    __tablename__ = "answer_latency"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    stt_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    llm_first_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    llm_total_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=_now)


class AnswerFeedback(Base):
    """User's 👍/👎 on a generated answer — the raw material for prompt and
    glossary tuning (downvotes carry the question + answer for later review)."""

    __tablename__ = "answer_feedback"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    verdict: Mapped[str] = mapped_column(String)  # up | down
    question: Mapped[str] = mapped_column(Text, default="")
    answer: Mapped[str] = mapped_column(Text, default="")
    raw_transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String, default="live")  # live | manual
    ts: Mapped[datetime] = mapped_column(DateTime, default=_now)


class AppMeta(Base):
    """Small key-value store for app-level facts (first run, license key…)."""

    __tablename__ = "app_meta"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
