import importlib.util
import io
import tarfile
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("deploy.py")
SPEC = importlib.util.spec_from_file_location("skillcue_deploy", MODULE_PATH)
deploy = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(deploy)


def test_openrouter_key_is_deployed_to_openrouter_upstream(monkeypatch, tmp_path):
    monkeypatch.setattr(deploy, "read_openrouter_key", lambda: "sk-or-v1-test")
    monkeypatch.setattr(deploy, "read_openai_key", lambda: "stt-key")
    monkeypatch.setattr(deploy, "read_openai_chat_key", lambda: "chat-key")
    monkeypatch.setattr(deploy, "read_yookassa_secret", lambda: "yookassa-test")
    monkeypatch.setattr(deploy, "admin_secret", lambda: "admin-test")
    monkeypatch.setattr(deploy, "SIGNING_KEY_FILE", tmp_path / "missing-signing-key")

    env = deploy.build_env()

    assert "OPENROUTER_API_KEY=sk-or-v1-test" in env
    assert "GATEWAY_UPSTREAM_BASE=https://openrouter.ai/api/v1" in env
    assert "GATEWAY_UPSTREAM_STYLE=openrouter" in env
    assert "OPENAI_API_KEY=stt-key" in env
    assert "OPENAI_CHAT_API_KEY=chat-key" in env
    assert "OPENAI_CHAT_BASE_URL=https://api.openai.com/v1" in env
    assert "OPENAI_CHAT_REQUIRED=1" in env
    assert (
        "GATEWAY_STRUCTURED_SCREEN_ALLOWED_MODELS="
        "openai/gpt-5.6-sol,openai/gpt-5.6" in env
    )


def test_account_env_contains_required_server_only_configuration(monkeypatch, tmp_path):
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    monkeypatch.setenv(
        "SKILLCUE_GOOGLE_OAUTH_CLIENT_ID",
        "client.apps.googleusercontent.com",
    )
    monkeypatch.setattr(deploy, "read_yookassa_secret", lambda: "yookassa-test")
    monkeypatch.setattr(deploy, "ACCOUNT_SECRETS_FILE", tmp_path / "account-secrets.json")
    signing_key = tmp_path / "signing-key"
    signing_key.write_text("ab" * 32, encoding="utf-8")
    monkeypatch.setattr(deploy, "SIGNING_KEY_FILE", signing_key)

    env = deploy.build_account_env()

    assert "ACCOUNT_API_HOST=127.0.0.1" in env
    assert "DATABASE_URL=postgresql://skillcue_account:" in env
    assert "RESEND_API_KEY=re_test_key" in env
    assert "GOOGLE_OAUTH_CLIENT_ID=client.apps.googleusercontent.com" in env
    assert f"LICENSE_PRIVATE_KEY_HEX={'ab' * 32}" in env
    assert "JWT_ACCESS_SECRET=" in env
    assert "DEVICE_ID_SECRET=" in env


def test_account_env_supports_an_explicit_free_port(monkeypatch, tmp_path):
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    monkeypatch.setenv(
        "SKILLCUE_GOOGLE_OAUTH_CLIENT_ID",
        "client.apps.googleusercontent.com",
    )
    monkeypatch.setenv("SKILLCUE_ACCOUNT_API_PORT", "8789")
    monkeypatch.setattr(deploy, "read_yookassa_secret", lambda: "yookassa-test")
    monkeypatch.setattr(deploy, "ACCOUNT_SECRETS_FILE", tmp_path / "account-secrets.json")
    signing_key = tmp_path / "signing-key"
    signing_key.write_text("ab" * 32, encoding="utf-8")
    monkeypatch.setattr(deploy, "SIGNING_KEY_FILE", signing_key)

    env = deploy.build_account_env()

    assert "ACCOUNT_API_PORT=8789" in env


def test_passwordless_sudo_wraps_only_privileged_deployment_commands():
    wrapped, needs_pty = deploy.remote_command(
        "bash /opt/skillcue/setup.sh",
        use_sudo=True,
        sudo_pass=None,
    )

    assert wrapped.startswith("sudo -n bash -c ")
    assert "/opt/skillcue/setup.sh" in wrapped
    assert needs_pty is False


def test_account_env_refuses_to_deploy_without_google_or_mail(monkeypatch, tmp_path):
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.delenv("SKILLCUE_GOOGLE_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.setattr(deploy, "ACCOUNT_SECRETS_FILE", tmp_path / "account-secrets.json")

    try:
        deploy.build_account_env()
    except RuntimeError as error:
        assert "RESEND_API_KEY" in str(error)
    else:
        raise AssertionError("account deployment must fail closed")


def test_account_env_refuses_to_deploy_without_license_signing_key(monkeypatch, tmp_path):
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    monkeypatch.setenv("SKILLCUE_GOOGLE_OAUTH_CLIENT_ID", "client.apps.googleusercontent.com")
    monkeypatch.setattr(deploy, "SIGNING_KEY_FILE", tmp_path / "missing-signing-key")

    try:
        deploy.build_account_env()
    except RuntimeError as error:
        assert ".license_signing_key" in str(error)
    else:
        raise AssertionError("account deployment must fail without entitlement signing")


def test_account_deploy_enables_public_https_route_after_service_setup():
    steps = deploy.deployment_steps(with_account=True, domain="skill-cue.ru")

    account_index = next(i for i, step in enumerate(steps) if "setup-account-vps.sh" in step)
    web_index = next(i for i, step in enumerate(steps) if "setup-web.sh" in step)
    assert account_index < web_index
    assert "DOMAIN=skill-cue.ru" in steps[web_index]


def test_pi_account_setup_uses_configured_port_and_tunnel_nginx_route():
    deploy_dir = Path(__file__).parent
    account_setup = (deploy_dir / "setup-account-vps.sh").read_text(encoding="utf-8")
    web_setup = (deploy_dir / "setup-web.sh").read_text(encoding="utf-8")

    assert "ACCOUNT_API_PORT" in account_setup
    assert "127.0.0.1:${ACCOUNT_PORT}/health" in account_setup
    assert "CI=true pnpm install" in account_setup
    assert "listen 127.0.0.1:8080" in web_setup
    assert "BEGIN SKILLCUE ACCOUNT" in web_setup
    assert "PI_NGINX_ENABLED" in web_setup
    assert 'readlink -f "$PI_NGINX_ENABLED"' in web_setup
    assert 'PI_NGINX_BACKUP_DIR="$APP_DIR/backups/nginx-account-route"' in web_setup
    assert '"${PI_NGINX_CONF}.before-account"' not in web_setup
    assert 'grep -F \'"service":"skillcue-account"\' >/dev/null' in web_setup


def test_deploy_bundle_never_contains_local_account_or_environment_secrets(monkeypatch, tmp_path):
    deploy_dir = tmp_path / "apps" / "api" / "deploy"
    deploy_dir.mkdir(parents=True)
    (deploy_dir / "setup.sh").write_text("safe", encoding="utf-8")
    (deploy_dir / ".account_secrets.json").write_text("private", encoding="utf-8")
    (deploy_dir / ".admin_secret").write_text("private", encoding="utf-8")
    (tmp_path / "apps" / "api" / ".env").write_text("TOKEN=private", encoding="utf-8")
    monkeypatch.setattr(deploy, "REPO", tmp_path)
    monkeypatch.setattr(deploy, "BUNDLE_INCLUDE", ["apps/api"])

    with tarfile.open(fileobj=io.BytesIO(deploy.build_bundle()), mode="r:gz") as archive:
        names = archive.getnames()

    assert any(name.endswith("setup.sh") for name in names)
    assert not any(name.endswith(".account_secrets.json") for name in names)
    assert not any(name.endswith(".admin_secret") for name in names)
    assert not any(name.endswith("/.env") for name in names)
