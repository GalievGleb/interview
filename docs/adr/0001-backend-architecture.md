# ADR 0001 — Backend architecture & monetization path

Status: **Accepted** — Option A (local-first, BYO-key, offline-лицензии)
Date: 2026-06-25

> **Update (после аудита):** Option A уже реализован в продукте: монетизация —
> оффлайн Ed25519-лицензии, активируемые deep-link `skillcue://activate?key=…`
> (`apps/desktop` LicenseCard / main.ts) и выпускаемые webhook'ом LemonSqueezy
> (`tools/license_webhook.py`). Путь к серверному биллингу описан в SECURITY.md
> («Красная линия»: proxy.skillcue.app) — `apps/api` сохраняется как заготовка
> под него и до подключения считается legacy.

## Context

The repo currently ships **two backends**:

- **`apps/api-py`** (FastAPI, SQLite, local) — the one the desktop app actually
  talks to. Handles STT (cloud OpenAI transcription), LLM answer generation, sessions,
  documents/RAG, settings. **No authentication** (it binds to `127.0.0.1` and is
  a single-user local process). Uses the user's own OpenAI/OpenRouter keys.

- **`apps/api`** (NestJS, Postgres + Redis, `docker-compose.yml`) — a full SaaS
  layer: JWT auth, Stripe + YooKassa billing, subscriptions, plan limits,
  Prisma, an STT gateway and LLM service. **The desktop app does not call it at
  all** (verified: no `login` / `checkout` / `subscription` / `billing` usage in
  `apps/desktop/src`).

The result is a split-brain: the "subscription product" has billing code that is
not wired to the shipped app, so there is currently **no access control or
metering** — anyone with the desktop app and their own LLM key can use it freely.

## Decision (recommended)

Pick one of two coherent models and remove the ambiguity:

### Option A — Local-first, BYO-key (recommended for current state)
Position the product honestly as a **local desktop tool**:
- Keep `apps/api-py` as the only backend.
- Archive/remove `apps/api` + `docker-compose.yml` (move to a `legacy/` branch or
  tag so the billing work isn't lost).
- Monetize via an **offline license key** (Gumroad / Lemon Squeezy / Paddle)
  activated in the desktop app — no server round-trip required for core use.
- Pros: matches the privacy/local positioning, simplest to ship, lowest infra.
- Cons: weaker recurring-revenue control than a true SaaS.

### Option B — Full SaaS
Wire the desktop to `apps/api`:
- Desktop logs in → receives JWT → checks subscription before `Start Live` /
  answer generation.
- `apps/api-py` remains the **local engine**, but feature-gated by the license
  state fetched from `apps/api`.
- Pros: real subscription enforcement, usage metering, managed keys possible.
- Cons: more infra (Postgres/Redis), more surface, conflicts somewhat with the
  "audio never leaves device" story if keys/usage are centralized.

## Consequences

- Until this is decided, **do not** treat the `apps/api` billing code as live;
  it is effectively dead relative to the shipped app.
- Whichever option is chosen, document it in the root README and delete the other
  path's dead code to avoid confusion.
- This ADR intentionally does **not** delete `apps/api` — that is a product
  decision for the owner.
