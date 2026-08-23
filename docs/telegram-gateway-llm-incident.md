# Telegram gateway: LLM readiness

## Root cause

The Jarvis gateway loaded `LLM_ROUTER_ENABLED=true`, but both model variables were
empty. Its startup code treated an empty model as `llm_chat=None`, so a normal text
message reached the AI branch and returned an internal configuration error instead
of making a request.

## Required invariant

The gateway may start polling only after it has either:

1. an explicitly configured chat model; or
2. discovered a non-embedding model from the configured OpenAI-compatible
   `GET /v1/models` endpoint.

The model name and provider URL are runtime configuration; credentials must never
be committed to this repository.

## Current fix

`outputs/services/telegram_gateway/bot.py` now discovers a model when the explicit
model variables and router state are empty, skips embedding/projector artifacts,
and keeps internal configuration details in stderr only. Telegram users receive a
generic retry message if the provider is unreachable.

The source used by the deployed bot is the gateway bundle under
`C:\Users\gleb\Documents\Codex\2026-08-19\new-chat-2\outputs` in the current
development workspace. Deployment still requires restarting that service after
copying the patched `bot.py`; do not claim production is fixed until the service
logs show a discovered model and a real `/chat/completions` response.

## Smoke check

```powershell
cd C:\Users\gleb\Documents\Codex\2026-08-19\new-chat-2
py -3 -m pytest -q outputs/services/telegram_gateway/test_bot_llm.py
py -3 -m py_compile outputs/services/telegram_gateway/bot.py
```

For a live provider check, query `/v1/models` and then send one short
`/v1/chat/completions` request. Never paste API keys into logs, tests, or git.
