"""Local reproduction of the public SQL Academy 69 screenshot, no user data."""

# ruff: noqa: E402
import asyncio
import base64
import json
import os
import re
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "apps/api-py"))
from dev_e2e_identity import seed_installed_gateway_identity
from verify_screen_code_task import _render_text_png

scratch = Path(tempfile.mkdtemp(prefix="skillcue-sql69-"))
database = scratch / "test.sqlite"
seed_installed_gateway_identity(database)
os.environ.update(
    DATABASE_URL=f"sqlite:///{database.as_posix()}",
    SKILLCUE_GATEWAY_URL="https://skill-cue.ru/v1",
    PYTHON_KEYRING_BACKEND="keyring.backends.null.Keyring",
    OPENAI_API_KEY="",
    OPENROUTER_API_KEY="",
)
from app.db.session import init_db
from app.services import provider_adapter
from app.services.screen_task_pipeline import run_screen_task_pipeline

init_db()


async def traced(messages, *args, **kwargs):
    result = await provider_adapter.complete(messages, *args, **kwargs)
    phase = kwargs.get("screen_workload_phase")
    print(json.dumps({"phase": phase, "response_chars": len(result)}), flush=True)
    return result


async def main():
    image = _render_text_png(
        "Заработок владельцев комнат",
        [
            "Вывести идентификаторы всех владельцев комнат, что размещены",
            "на сервисе бронирования жилья и сумму, которую они заработали.",
            'Используйте конструкцию "as owner_id" и "as total_earn"',
            "для вывода идентификаторов владельцев и заработанной суммы.",
            "Поля в результирующей таблице: owner_id, total_earn",
            "Rooms: id INT, owner_id INT, price INT, address VARCHAR",
            "Reservations: id INT, room_id INT, user_id INT, total INT",
            "Users: id INT, name VARCHAR",
        ],
    )
    for attempt in range(3):
        result = await run_screen_task_pipeline(
            previous_images=(),
            current_image="data:image/png;base64," + base64.b64encode(image).decode(),
            latest_correction="",
            context="",
            prior_solution_summary=None,
            task_action="new",
            task_state=None,
            provider="openrouter",
            model="deepseek/deepseek-v4.1-flash",
            max_tokens=provider_adapter.screen_stream_options("deepseek/deepseek-v4.1-flash")[0],
            reasoning=provider_adapter.screen_stream_options("deepseek/deepseek-v4.1-flash")[1],
            complete=traced,
        )
        code = re.search(r"```sql\n(.*?)```", result.answer, re.S).group(1)
        with sqlite3.connect(":memory:") as db:
            db.executescript("""CREATE TABLE Rooms(id INTEGER, owner_id INTEGER);
                CREATE TABLE Reservations(room_id INTEGER, total INTEGER);
                INSERT INTO Rooms VALUES(1,10),(2,10),(3,20),(4,30);
                INSERT INTO Reservations VALUES(1,100),(1,50),(2,20),(3,40);""")
            cursor = db.execute(code)
            assert [column[0] for column in cursor.description] == ["owner_id", "total_earn"]
            assert sorted(cursor.fetchall()) == [(10, 170), (20, 40), (30, 0)]
        print(
            json.dumps(
                {"attempt": attempt + 1, "passed": True, "answer": result.answer},
                ensure_ascii=False,
            ),
            flush=True,
        )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    finally:
        from app.db.session import engine

        engine.dispose()
        database.unlink(missing_ok=True)
        for suffix in ("-shm", "-wal", "-journal"):
            database.with_name(database.name + suffix).unlink(missing_ok=True)
        scratch.rmdir()
