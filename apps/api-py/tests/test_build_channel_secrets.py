from app.services.secrets import service_name


def test_stable_and_dev_use_separate_os_keyring_services() -> None:
    assert service_name("stable") == "interview-copilot"
    assert service_name(None) in {"interview-copilot", "interview-copilot-dev"}
    assert service_name("dev") == "interview-copilot-dev"
