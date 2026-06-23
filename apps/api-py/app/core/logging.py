import logging
import re

_SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"sk-or-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"Bearer\s+[A-Za-z0-9_\-\.]+"),
]


class SecretRedactingFilter(logging.Filter):
    """Не пропускает в логи API-ключи и Bearer-токены."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            msg = record.msg
            for pattern in _SECRET_PATTERNS:
                msg = pattern.sub("[REDACTED]", msg)
            record.msg = msg
        return True


def setup_logging(level: str = "info") -> None:
    handler = logging.StreamHandler()
    handler.addFilter(SecretRedactingFilter())
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s - %(message)s")
    )
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
