from __future__ import annotations

import os
import subprocess
from pathlib import Path


def test_orchestrator_lists_safe_commands_without_echoing_environment_secrets() -> None:
    root = Path(__file__).resolve().parents[2]
    secret = "DO_NOT_PRINT_THIS_CREDENTIAL"
    result = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(root / "tools" / "verify_real_interview_overlay.ps1"),
            "-ListOnly",
            "-SkipLiveModel",
            "-SkipVisual",
        ],
        cwd=root,
        env={**os.environ, "OPENROUTER_API_KEY": secret},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=20,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "test_real_interview_overlay_regressions.py" in result.stdout
    assert "realInterviewOverlayRegression.test.ts" in result.stdout
    assert "LIST ONLY — NO GATES EXECUTED" in result.stdout
    assert "GATES PASSED" not in result.stdout
    assert secret not in result.stdout
    assert secret not in result.stderr
