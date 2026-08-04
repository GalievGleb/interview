"""Serialize analysis generation with destructive session mutations.

The packaged backend is one process backed by SQLite. Foreign-key cascades are
not guaranteed on every existing database, so process-local keyed locks protect
the analysis/delete boundary and also deduplicate concurrent model calls.
"""

from __future__ import annotations

import asyncio
from contextlib import ExitStack, asynccontextmanager, contextmanager
from threading import Lock

_registry_guard = Lock()
_entries: dict[str, dict] = {}


def _retain(session_id: str) -> dict:
    with _registry_guard:
        entry = _entries.get(session_id)
        if entry is None:
            entry = {"lock": Lock(), "references": 0}
            _entries[session_id] = entry
        entry["references"] += 1
        return entry


def _release_reference(session_id: str, entry: dict) -> None:
    with _registry_guard:
        entry["references"] -= 1
        if entry["references"] == 0 and _entries.get(session_id) is entry:
            _entries.pop(session_id, None)


@contextmanager
def session_mutation_lock(session_id: str):
    entry = _retain(session_id)
    lock = entry["lock"]
    lock.acquire()
    try:
        yield
    finally:
        lock.release()
        _release_reference(session_id, entry)


@asynccontextmanager
async def async_session_mutation_lock(session_id: str):
    entry = _retain(session_id)
    lock = entry["lock"]
    acquired = False
    try:
        await asyncio.to_thread(lock.acquire)
        acquired = True
        yield
    finally:
        if acquired:
            lock.release()
        _release_reference(session_id, entry)


@contextmanager
def session_mutation_locks(session_ids: list[str]):
    with ExitStack() as stack:
        for session_id in sorted(set(session_ids)):
            stack.enter_context(session_mutation_lock(session_id))
        yield
