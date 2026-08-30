import pytest
import subprocess
import sys
from pathlib import Path

from tools.verify_long_live_session import parse_checkpoint_minutes


def test_checkpoint_parser_keeps_literal_post_hour_probes():
    assert parse_checkpoint_minutes("0,30,61,91", duration_minutes=95) == (
        0.0,
        30.0,
        61.0,
        91.0,
    )


@pytest.mark.parametrize(
    "raw",
    ("", "0,0", "-1,30", "0,96", "zero,30"),
)
def test_checkpoint_parser_rejects_a_soak_that_cannot_prove_the_requested_window(raw):
    with pytest.raises(ValueError):
        parse_checkpoint_minutes(raw, duration_minutes=95)


def test_verifier_can_be_invoked_by_its_script_path():
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [sys.executable, str(root / "tools" / "verify_long_live_session.py"), "--help"],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr
