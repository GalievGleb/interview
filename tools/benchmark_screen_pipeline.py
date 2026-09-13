"""Manual, paid screen benchmark using an existing Alpha account (no trial claims)."""
from __future__ import annotations

import argparse
from contextlib import closing
import asyncio
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'apps' / 'api-py'))
sys.path.insert(0, str(ROOT / 'tools'))


async def benchmark(args):
    from app.services import provider_adapter
    from app.services.screen_task_pipeline import run_screen_task_pipeline
    from verify_screen_code_task import render_sql_solution_png, _data_url

    calls = []

    async def measured(messages, *positional, **kwargs):
        if args.effort and kwargs.get('reasoning'):
            kwargs['reasoning'] = {'effort': args.effort, 'exclude': True}
        started = time.perf_counter()
        try:
            return await provider_adapter.complete(messages, *positional, **kwargs)
        finally:
            item = {'phase': kwargs.get('screen_workload_phase'),
                    'ms': round((time.perf_counter() - started) * 1000)}
            calls.append(item)
            print(json.dumps(item), flush=True)

    tokens, reasoning = provider_adapter.screen_stream_options(args.model)
    started = time.perf_counter()
    result = await run_screen_task_pipeline(
        previous_images=(), current_image=_data_url(render_sql_solution_png()),
        latest_correction='', context='', prior_solution_summary=None,
        task_action='new', task_state=None, provider='openrouter', model=args.model,
        max_tokens=tokens, reasoning=reasoning, complete=measured,
    )
    print(json.dumps({'model': args.model, 'effort': args.effort,
                      'total_ms': round((time.perf_counter() - started) * 1000),
                      'calls': calls, 'answer': result.answer}, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='openai/gpt-5.6-sol')
    parser.add_argument('--effort', choices=['none', 'low', 'medium'])
    args = parser.parse_args()
    source = Path(os.environ['APPDATA']) / 'SkillCue Alpha/backend-data/copilot.sqlite'
    with tempfile.TemporaryDirectory(prefix='skillcue-screen-bench-') as directory:
        database = Path(directory) / 'bench.sqlite'
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src:
            rows = src.execute(
                "SELECT key, value FROM app_meta WHERE key IN ('install_id', 'managed_license_key')"
            ).fetchall()
        if not dict(rows).get('managed_license_key'):
            raise RuntimeError('Sign in to Alpha first; no trial identity will be created.')
        with closing(sqlite3.connect(database)) as db:
            db.execute('CREATE TABLE app_meta (key VARCHAR PRIMARY KEY, value TEXT NOT NULL)')
            db.executemany('INSERT INTO app_meta VALUES (?, ?)', rows)
            db.commit()
        os.environ.update(DATABASE_URL=f'sqlite:///{database.as_posix()}',
                          SKILLCUE_BUILD_CHANNEL='alpha',
                          SKILLCUE_GATEWAY_URL='https://skill-cue.ru/v1',
                          OPENAI_API_KEY='', OPENROUTER_API_KEY='',
                          PYTHON_KEYRING_BACKEND='keyring.backends.null.Keyring')
        try:
            asyncio.run(benchmark(args))
        finally:
            from app.db.session import engine
            engine.dispose()


if __name__ == '__main__':
    main()
