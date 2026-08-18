from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

settings = get_settings()

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False},
    # WAL mode enables concurrent reads while a write is in progress. Without it,
    # a streaming response that writes transcription chunks can raise "database
    # is locked" when another request tries to read session history at the same
    # time. Applied on every connection; SQLite's default is "delete".
    # Only meaningful for SQLite (Postgres/others ignore it).
)
# Enable WAL mode on each new SQLite connection.
from sqlalchemy import event

@event.listens_for(engine, "connect")
def _set_wal(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from app.db import models  # noqa: F401

    models.Base.metadata.create_all(bind=engine)
