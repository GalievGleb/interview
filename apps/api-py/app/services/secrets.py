import logging

from app.config import get_settings

logger = logging.getLogger("secrets")

SERVICE_NAME = "interview-copilot"

_VALID_KEYS = {"openai_api_key", "openrouter_api_key", "deepgram_api_key"}

# Кэш в памяти на случай, если OS keyring недоступен (headless/CI).
_memory_store: dict[str, str] = {}

try:
    import keyring

    _keyring_available = True
except Exception:  # pragma: no cover
    keyring = None  # type: ignore
    _keyring_available = False


def set_secret(name: str, value: str) -> None:
    if name not in _VALID_KEYS:
        raise ValueError(f"Unknown secret: {name}")
    _memory_store[name] = value
    if _keyring_available:
        try:
            keyring.set_password(SERVICE_NAME, name, value)
        except Exception:
            logger.warning("OS keyring unavailable, using in-memory store for %s", name)


def get_secret(name: str) -> str:
    """Порядок: keyring -> память -> .env (settings)."""
    if name not in _VALID_KEYS:
        raise ValueError(f"Unknown secret: {name}")

    if _keyring_available:
        try:
            value = keyring.get_password(SERVICE_NAME, name)
            if value:
                return value
        except Exception:
            pass

    if name in _memory_store:
        return _memory_store[name]

    settings = get_settings()
    return getattr(settings, name, "") or ""


def delete_secret(name: str) -> None:
    _memory_store.pop(name, None)
    if _keyring_available:
        try:
            keyring.delete_password(SERVICE_NAME, name)
        except Exception:
            pass


def has_secret(name: str) -> bool:
    return bool(get_secret(name))
