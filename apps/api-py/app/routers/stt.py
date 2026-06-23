import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import get_settings
from app.services import stt_service

logger = logging.getLogger("stt")

router = APIRouter(prefix="/stt", tags=["stt"])

ALLOWED_SAMPLE_RATES = {16000, 44100, 48000}


@router.websocket("/stream")
async def stt_stream(ws: WebSocket) -> None:
    await ws.accept()
    settings = get_settings()

    if not settings.stt_enabled:
        await ws.send_json({"type": "error", "message": "STT отключён в настройках"})
        await ws.close()
        return

    language = ws.query_params.get("language") or settings.stt_language
    mode = ws.query_params.get("mode", "fast")
    engine = ws.query_params.get("engine", "nova3-multi")
    try:
        sample_rate = int(ws.query_params.get("sample_rate", "16000"))
    except ValueError:
        sample_rate = 16000
    if sample_rate not in ALLOWED_SAMPLE_RATES:
        sample_rate = 16000

    try:
        await stt_service.run_proxy(
            ws,
            language=language,
            engine=engine,
            sample_rate=sample_rate,
            mode=mode,
        )
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        logger.exception("STT stream error")
    finally:
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
