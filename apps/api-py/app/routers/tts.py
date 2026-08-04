"""Local authenticated natural speech endpoint for the desktop renderer."""

from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field

from app.services import tts as tts_service

router = APIRouter(prefix="/tts", tags=["tts"])


class SpeechPayload(BaseModel):
    input: str = Field(min_length=1, max_length=800)
    language: Literal["ru", "en"] = "ru"


@router.post("/speech")
async def speech(payload: SpeechPayload) -> Response:
    audio = await tts_service.synthesize_speech(payload.input, payload.language)
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"Cache-Control": "private, max-age=86400"},
    )
