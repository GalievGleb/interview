import pytest

from app.services.preferences import validate_base_url


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/api/v1",
        "http://10.0.0.1:11434/v1",
        "http://169.254.169.254/latest",
        "file:///etc/passwd",
    ],
)
def test_base_url_rejects_untrusted_or_private_hosts(url):
    with pytest.raises(ValueError):
        validate_base_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://api.openai.com/v1",
        "https://openrouter.ai/api/v1",
        "http://127.0.0.1:11434/v1",
        "http://localhost:11434/v1",
    ],
)
def test_base_url_accepts_allowed_hosts(url):
    assert validate_base_url(url) == url.rstrip("/")
