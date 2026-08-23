"""Shared test fixtures: an isolated in-memory SQLite DB + HTTP client.

All HTTP tests share one in-memory engine via a `get_db` dependency override so
the real dev database is never touched. Tables are recreated before every test.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core import local_auth
from app.db import models
from app.db.session import get_db
from app.main import app

_engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=_engine, autoflush=False, autocommit=False)


def _override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _local_api_auth(monkeypatch):
    monkeypatch.setattr(local_auth, "API_TOKEN", "test-local-token")


@pytest.fixture(autouse=True)
def _fresh_db():
    """Reset the override + schema before each test (import-order independent)."""
    app.dependency_overrides[get_db] = _override_get_db
    models.Base.metadata.drop_all(bind=_engine)
    models.Base.metadata.create_all(bind=_engine)
    yield
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app, headers={"X-SkillCue-Token": local_auth.API_TOKEN})


@pytest.fixture
def db_session():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
