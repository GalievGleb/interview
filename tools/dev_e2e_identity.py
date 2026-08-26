"""Seed isolated installed-dev verifiers with the existing app identity only."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

_IDENTITY_KEYS = ("install_id", "license_email", "license_key")


def _installed_dev_database() -> Path:
    override = os.environ.get("SKILLCUE_E2E_IDENTITY_DB", "").strip()
    if override:
        return Path(override)
    return Path(os.environ["APPDATA"]) / "SkillCue Dev" / "backend-data" / "copilot.sqlite"


def seed_installed_gateway_identity(target_database: Path) -> None:
    """Copy only gateway identity rows into a disposable verifier database.

    A fresh database claims a new trial on every verification run. Besides
    making the test unreliable, that eventually causes STT authorization to
    fail before the supplied audio is exercised. Reuse the installed Dev
    identity without copying transcripts, resumes, answers, or other user data.
    """

    source_database = _installed_dev_database()
    if not source_database.exists():
        raise RuntimeError(
            "Installed SkillCue Dev identity database was not found. "
            "Launch and activate the Dev app once before running installed E2E checks."
        )

    source_uri = f"{source_database.resolve().as_uri()}?mode=ro"
    with sqlite3.connect(source_uri, uri=True, timeout=5) as source:
        placeholders = ",".join("?" for _ in _IDENTITY_KEYS)
        rows = source.execute(
            f"SELECT key, value FROM app_meta WHERE key IN ({placeholders})",
            _IDENTITY_KEYS,
        ).fetchall()

    values = {str(key): str(value or "") for key, value in rows}
    if not values.get("license_key") or not values.get("install_id"):
        raise RuntimeError(
            "Installed SkillCue Dev has no active gateway identity. "
            "Launch and activate the Dev app once before running installed E2E checks."
        )

    target_database.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(target_database, timeout=5) as target:
        target.execute(
            "CREATE TABLE IF NOT EXISTS app_meta "
            "(key VARCHAR NOT NULL PRIMARY KEY, value TEXT NOT NULL DEFAULT '')"
        )
        target.executemany(
            "INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)",
            [(key, values[key]) for key in _IDENTITY_KEYS if values.get(key)],
        )
        target.commit()
