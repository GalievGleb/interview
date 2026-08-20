import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("deploy.py")
SPEC = importlib.util.spec_from_file_location("skillcue_deploy", MODULE_PATH)
deploy = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(deploy)


def test_openrouter_key_is_deployed_to_openrouter_upstream(monkeypatch, tmp_path):
    monkeypatch.setattr(deploy, "read_openrouter_key", lambda: "sk-or-v1-test")
    monkeypatch.setattr(deploy, "admin_secret", lambda: "admin-test")
    monkeypatch.setattr(deploy, "SIGNING_KEY_FILE", tmp_path / "missing-signing-key")

    env = deploy.build_env()

    assert "OPENROUTER_API_KEY=sk-or-v1-test" in env
    assert "GATEWAY_UPSTREAM_BASE=https://openrouter.ai/api/v1" in env
    assert "GATEWAY_UPSTREAM_STYLE=openrouter" in env
