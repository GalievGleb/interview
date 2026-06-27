"""Frozen entry point for the packaged backend (PyInstaller onedir build).

Dev still runs ``uvicorn app.main:app`` directly; the packaged Electron app spawns
this binary instead and passes the port via the ``SKILLCUE_PORT`` env var.
"""

from __future__ import annotations

import os

import uvicorn

from app.main import app


def main() -> None:
    port = int(os.environ.get("SKILLCUE_PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
