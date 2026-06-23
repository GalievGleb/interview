from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    api_host: str = "127.0.0.1"
    api_port: int = 8000

    database_url: str = f"sqlite:///{(DATA_DIR / 'copilot.sqlite').as_posix()}"

    default_provider: str = "openrouter"
    default_model: str = "openai/gpt-4o-mini"

    openai_api_key: str = ""
    openrouter_api_key: str = ""
    deepgram_api_key: str = ""

    embedding_provider: str = "openai"
    embedding_model: str = "text-embedding-3-small"

    stt_enabled: bool = True
    stt_language: str = "multi"

    max_chat_requests_per_min: int = 20
    max_stt_minutes_per_session: int = 60

    privacy_mode: bool = False
    log_level: str = "info"

    cors_origins: str = "*"


@lru_cache
def get_settings() -> Settings:
    return Settings()
