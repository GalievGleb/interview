from app.services import secrets
from app.services.secrets import service_name


def test_stable_and_dev_use_separate_os_keyring_services() -> None:
    assert service_name("stable") == "interview-copilot"
    assert service_name(None) in {"interview-copilot", "interview-copilot-dev"}
    assert service_name("dev") == "interview-copilot-dev"


def test_dev_falls_back_to_owner_stable_byok_key(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []

    def get_password(service: str, name: str) -> str | None:
        calls.append((service, name))
        return "sk-owner" if service == "interview-copilot" else None

    monkeypatch.setattr(secrets, "SERVICE_NAME", "interview-copilot-dev")
    monkeypatch.setattr(secrets, "_keyring_available", True)
    monkeypatch.setattr(secrets.keyring, "get_password", get_password)

    assert secrets.get_secret("openrouter_api_key") == "sk-owner"
    assert calls == [
        ("interview-copilot-dev", "openrouter_api_key"),
        ("interview-copilot", "openrouter_api_key"),
    ]


def test_stable_never_reads_dev_keyring(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []

    def get_password(service: str, name: str) -> str | None:
        calls.append((service, name))
        return None

    monkeypatch.setattr(secrets, "SERVICE_NAME", "interview-copilot")
    monkeypatch.setattr(secrets, "_keyring_available", True)
    monkeypatch.setattr(secrets.keyring, "get_password", get_password)
    monkeypatch.setattr(secrets, "get_settings", lambda: type("S", (), {"openrouter_api_key": ""})())

    assert secrets.get_secret("openrouter_api_key") == ""
    assert calls == [("interview-copilot", "openrouter_api_key")]
