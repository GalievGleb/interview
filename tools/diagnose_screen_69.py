"""Replay a local task screenshot through the real model; print no credentials."""
import asyncio
import base64
import sys
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(ROOT / 'apps/api-py'))
from app.services import screen_task_pipeline as pipeline, provider_adapter

async def main():
    image = 'data:image/png;base64,' + base64.b64encode(Path(sys.argv[1]).read_bytes()).decode()
    original = pipeline.validate_screen_answer
    def validate(value):
        result = original(value)
        print('VALIDATION', [c.value for c in result.issue_codes], flush=True)
        return result
    pipeline.validate_screen_answer = validate
    calls = []
    async def complete(messages, *args, **kwargs):
        result = await provider_adapter.complete(messages, *args, **kwargs)
        calls.append({'phase': kwargs.get('screen_workload_phase'), 'response': result})
        print('PHASE', kwargs.get('screen_workload_phase'), len(result), flush=True)
        return result
    model = 'deepseek/deepseek-v4.1-flash'
    budget, reasoning = provider_adapter.screen_stream_options(model)
    try:
        result = await pipeline.run_screen_task_pipeline(previous_images=(), current_image=image,
            latest_correction='Реши текущее задание на экране.', context='', prior_solution_summary=None,
            task_action='new', task_state=None, provider='openrouter', model=model,
            max_tokens=budget, reasoning=reasoning, complete=complete)
        print('SUCCESS', result.answer)
    finally:
        Path(sys.argv[1]).with_suffix('.diagnostics.json').write_text(json.dumps(calls, ensure_ascii=False, indent=2), encoding='utf-8')
        await provider_adapter.aclose_client()

if __name__ == '__main__':
    asyncio.run(main())
