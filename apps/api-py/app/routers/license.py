"""Лицензия: статус (trial-минуты / тариф / токен-бюджет) и активация ключа."""

import time

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.models import AppMeta
from app.db.session import get_db
from app.services.license import verify_license_key
from app.services.quota import current_entitlements

router = APIRouter(prefix="/license", tags=["license"])

_FIRST_RUN_KEY = "first_run_at"
_LICENSE_KEY = "license_key"
_LICENSE_EMAIL = "license_email"


def _set_meta(db: Session, key: str, value: str) -> None:
    row = db.get(AppMeta, key)
    if row is None:
        db.add(AppMeta(key=key, value=value))
    else:
        row.value = value


@router.get("/status")
def license_status(db: Session = Depends(get_db)) -> dict:
    # first_run фиксируем при первом же обращении (историческая метка).
    if db.get(AppMeta, _FIRST_RUN_KEY) is None:
        _set_meta(db, _FIRST_RUN_KEY, str(time.time()))
        db.commit()
    return current_entitlements(db)


class ActivatePayload(BaseModel):
    key: str


@router.post("/activate")
def activate_license(payload: ActivatePayload, db: Session = Depends(get_db)) -> dict:
    info = verify_license_key(payload.key)
    if info is None:
        raise AppError(
            "Ключ недействителен. Проверьте, что скопировали его целиком.", 400, "invalid_license"
        )
    _set_meta(db, _LICENSE_KEY, payload.key.strip())
    _set_meta(db, _LICENSE_EMAIL, str(info.get("email", "")))
    db.commit()
    return current_entitlements(db)
