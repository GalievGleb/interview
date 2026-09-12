from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load_verify_dev_overlay():
    path = ROOT / "tools" / "verify_dev_overlay.py"
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location("verify_dev_overlay_alpha_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_installed_overlay_verifier_selects_alpha_without_changing_dev_default(
    monkeypatch,
) -> None:
    module = _load_verify_dev_overlay()
    monkeypatch.setenv("LOCALAPPDATA", r"C:\Users\tester\AppData\Local")
    monkeypatch.delenv("SKILLCUE_E2E_BACKEND", raising=False)
    monkeypatch.delenv("SKILLCUE_E2E_CHANNEL", raising=False)

    assert module._e2e_channel() == "dev"
    assert module._installed_backend() == Path(
        r"C:\Users\tester\AppData\Local\Programs\skillcue-dev\resources\backend\skillcue-backend.exe"
    )

    monkeypatch.setenv("SKILLCUE_E2E_CHANNEL", "alpha")
    assert module._e2e_channel() == "alpha"
    assert module._installed_backend() == Path(
        r"C:\Users\tester\AppData\Local\Programs\skillcue-alpha\resources\backend\skillcue-backend.exe"
    )


def test_alpha_installer_is_bounded_to_the_private_alpha_product() -> None:
    installer = ROOT / "tools" / "install_and_verify_alpha.ps1"
    assert installer.exists()
    source = installer.read_text("utf-8")

    assert "release-alpha\\SkillCue-Alpha-Setup.exe" in source
    assert "Programs\\skillcue-alpha\\SkillCue Alpha.exe" in source
    assert "$env:SKILLCUE_E2E_CHANNEL = 'alpha'" in source
    assert "verify:dev:overlay" in source
    assert "verify:dev:ui" in source
    assert "verify:dev:voice" in source
    assert "verify:alpha:screen" in source
    assert "dist:alpha" in source
    assert "SkillCue-Dev-Setup.exe" not in source
    assert "SkillCue-Setup.exe" not in source
    assert "--publish" not in source


def test_screen_verifier_resolves_alpha_for_structured_installed_runs() -> None:
    source = (ROOT / "tools" / "verify_screen_code_task.py").read_text("utf-8")

    assert 'parser.add_argument("--channel", choices=("dev", "alpha"))' in source
    assert (
        'channel = args.channel or ("alpha" if args.structured_screen else "dev")'
        in source
    )
    assert 'f"skillcue-{channel}"' in source
    assert '"SKILLCUE_BUILD_CHANNEL": channel' in source
    assert '"SKILLCUE_GATEWAY_URL": _MANAGED_DEV_GATEWAY_URL' in source


def test_installed_overlay_verifier_mirrors_electron_managed_gateway_env() -> None:
    source = (ROOT / "tools" / "verify_dev_overlay.py").read_text("utf-8")
    assert '"SKILLCUE_GATEWAY_URL": "https://skill-cue.ru/v1"' in source


def test_alpha_installer_does_not_mutate_current_process_environment() -> None:
    # Contract documentation for the PowerShell finally block: child-test
    # variables are restored even if the smoke fails.
    source = (ROOT / "tools" / "install_and_verify_alpha.ps1").read_text("utf-8")
    assert "Remove-Item Env:SKILLCUE_E2E_CHANNEL" in source
    assert "Remove-Item Env:SKILLCUE_E2E_BACKEND" in source
    assert os.environ.get("SKILLCUE_E2E_CHANNEL") is None


def test_installed_electron_ui_verifier_can_target_alpha_without_changing_default() -> (
    None
):
    source = (
        ROOT / "apps" / "desktop" / "tools" / "verify-installed-dev-ui.mjs"
    ).read_text("utf-8")

    assert "process.env.SKILLCUE_E2E_CHANNEL" in source
    assert "channel === 'alpha' ? 'skillcue-alpha' : 'skillcue-dev'" in source
    assert "channel === 'alpha' ? 'SkillCue Alpha.exe' : 'SkillCue Dev.exe'" in source


def test_installed_voice_verifier_can_target_alpha_without_changing_default() -> None:
    source = (ROOT / "tools" / "verify_dev_voice_overlay.py").read_text("utf-8")

    assert 'os.environ.get("SKILLCUE_E2E_CHANNEL", "dev")' in source
    assert 'f"skillcue-{channel}"' in source
    assert '"SKILLCUE_BUILD_CHANNEL": channel' in source
