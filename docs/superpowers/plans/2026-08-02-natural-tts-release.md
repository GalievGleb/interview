# Natural TTS and Reliability Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the arbitrary robotic system voice with managed natural question speech, retain a reliable local fallback, and ship all reliability work as SkillCue 0.0.16 through the existing updater channel.

**Architecture:** The licensed gateway exposes one bounded, rate-limited TTS endpoint using a fixed OpenAI model/voice; the packaged FastAPI backend chooses direct-key or managed-gateway transport. A desktop speech hook caches WAV blobs, prefetches the next mock question, and falls back to a ranked installed voice without blocking interview flow.

**Tech Stack:** NestJS 11, Redis, OpenAI Audio Speech API, FastAPI/httpx, React 19, Web Audio/HTMLAudioElement, Vitest, pytest, electron-builder, GitHub Releases.

## Global Constraints

- Fixed managed model: `gpt-4o-mini-tts`; fixed primary voice: `marin`.
- TTS input is at most 800 normalized characters and 30 licensed requests per minute.
- Request WAV output and cache by normalized text, language, model, and voice.
- Show that the playback is AI-generated.
- A TTS failure falls back locally and never blocks a mock interview.
- Deploy the gateway before publishing desktop 0.0.16.
- Do not use the release script while the worktree is dirty; commit scoped work first, then tag the verified tree explicitly.

---

### Task 1: Licensed gateway TTS endpoint

**Files:**
- Create: `apps/api/src/gateway/gateway-tts.service.ts`
- Create: `apps/api/src/gateway/gateway-tts.service.test.ts`
- Modify: `apps/api/src/gateway/gateway.controller.ts`
- Modify: `apps/api/src/gateway/gateway.module.ts`

**Interfaces:**
- Consumes: verified license, `{ input, language }`, `OPENAI_API_KEY`, optional `OPENAI_TTS_BASE_URL`, and Redis rate limiting.
- Produces: authenticated `POST /gateway/tts/speech` returning `audio/wav`.

- [ ] **Step 1: Write failing TTS request and rate-limit tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GatewayTtsService,
  TTS_MODEL,
  TTS_VOICE,
  buildTtsUpstreamBody,
  normalizeTtsInput,
} from './gateway-tts.service';

test('managed TTS fixes model, voice, WAV, and natural Russian instructions', () => {
  assert.deepEqual(buildTtsUpstreamBody('Что такое тестирование?', 'ru'), {
    model: 'gpt-4o-mini-tts',
    voice: 'marin',
    input: 'Что такое тестирование?',
    response_format: 'wav',
    instructions: 'Говори естественно, спокойно и доброжелательно, как живой интервьюер. Без дикторской манеры.',
  });
  assert.equal(TTS_MODEL, 'gpt-4o-mini-tts');
  assert.equal(TTS_VOICE, 'marin');
});

test('managed TTS normalizes whitespace and rejects oversized input', () => {
  assert.equal(normalizeTtsInput('  Что   такое API?\n'), 'Что такое API?');
  assert.throws(() => normalizeTtsInput('x'.repeat(801)), /800/);
});

test('managed TTS rejects a license over its speech rate limit', async () => {
  const service = new GatewayTtsService({
    checkRateLimit: async () => false,
  } as never);
  await assert.rejects(
    () => service.synthesize(
      { id: 'license-1', payload: { email: 'test@local' }, budget: 10_000 } as never,
      'Что такое API?',
      'ru',
    ),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 429,
  );
});
```

- [ ] **Step 2: Build and run the test to verify failure**

Run: `pnpm --filter @interview/api build && node --test apps/api/dist/gateway/gateway-tts.service.test.js`

Expected: build FAIL because the new module is missing.

- [ ] **Step 3: Implement bounded input, fixed upstream body, and service**

```ts
import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import type { VerifiedLicense } from './license.util';

export const TTS_MODEL = 'gpt-4o-mini-tts';
export const TTS_VOICE = 'marin';
const MAX_TTS_CHARS = 800;
const TTS_RATE_LIMIT = 30;
const TTS_RATE_WINDOW_SECONDS = 60;

export function normalizeTtsInput(raw: string): string {
  const input = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!input || input.length > MAX_TTS_CHARS) {
    throw new BadRequestException(`TTS input must contain 1-${MAX_TTS_CHARS} characters`);
  }
  return input;
}

export function buildTtsUpstreamBody(input: string, language: string) {
  return {
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: normalizeTtsInput(input),
    response_format: 'wav',
    instructions: language === 'ru'
      ? 'Говори естественно, спокойно и доброжелательно, как живой интервьюер. Без дикторской манеры.'
      : 'Speak naturally, calmly, and warmly like a real interviewer, without an announcer voice.',
  } as const;
}

@Injectable()
export class GatewayTtsService {
  constructor(private readonly redis: RedisService) {}

  async synthesize(
    license: VerifiedLicense,
    input: string,
    language: string,
  ): Promise<Buffer> {
    const allowed = await this.redis.checkRateLimit(
      `gw:tts-rate:${license.id}`,
      TTS_RATE_LIMIT,
      TTS_RATE_WINDOW_SECONDS,
    );
    if (!allowed) {
      throw new HttpException(
        { error: { message: 'Слишком много запросов озвучки — подождите минуту.', code: 'rate_limited' } },
        429,
      );
    }
    const apiKey = process.env.OPENAI_API_KEY ?? '';
    if (!apiKey) {
      throw new HttpException(
        { error: { message: 'Озвучка временно недоступна.', code: 'gateway_unconfigured' } },
        503,
      );
    }
    const base = (process.env.OPENAI_TTS_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const response = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTtsUpstreamBody(input, language)),
    });
    if (!response.ok) {
      throw new HttpException(
        { error: { message: 'Не удалось создать озвучку.', code: 'tts_provider_error' } },
        response.status,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
```

- [ ] **Step 4: Add the authenticated controller route**

```ts
@Post('gateway/tts/speech')
@HttpCode(200)
async synthesizeSpeech(
  @Headers('authorization') auth: string | undefined,
  @Body() body: { input?: string; language?: string },
  @Res() response: Response,
) {
  const license = this.gateway.authorize(auth);
  const audio = await this.tts.synthesize(license, body.input ?? '', body.language ?? 'ru');
  response.setHeader('Content-Type', 'audio/wav');
  response.setHeader('Cache-Control', 'private, max-age=86400');
  response.send(audio);
}
```

Import `Response` from `express`, inject `GatewayTtsService` into the controller, and register the
service in `GatewayModule`. Nest's existing JSON parser handles this bounded request; keep the
800-character service limit authoritative and do not add the route to the raw STT body parser.

- [ ] **Step 5: Build and run gateway tests**

Run:

```powershell
pnpm --filter @interview/api build
node --test apps/api/dist/gateway/gateway-tts.service.test.js apps/api/dist/gateway/gateway-stt.service.test.js apps/api/dist/gateway/gateway-stt-quota.util.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit gateway TTS**

```powershell
git add apps/api/src/gateway/gateway-tts.service.ts apps/api/src/gateway/gateway-tts.service.test.ts apps/api/src/gateway/gateway.controller.ts apps/api/src/gateway/gateway.module.ts
git commit -m "feat: proxy licensed natural speech"
```

### Task 2: Packaged FastAPI speech transport

**Files:**
- Create: `apps/api-py/app/services/tts.py`
- Create: `apps/api-py/app/routers/tts.py`
- Modify: `apps/api-py/app/main.py`
- Create: `apps/api-py/tests/test_tts.py`

**Interfaces:**
- Consumes: direct stored OpenAI key or managed gateway license and `{ input, language }`.
- Produces: local authenticated `POST /tts/speech` returning WAV bytes.

- [ ] **Step 1: Write failing direct/gateway transport tests**

```py
from app.services import tts


def test_tts_endpoint_returns_wav(client, monkeypatch):
    async def fake_synthesize(input_text: str, language: str) -> bytes:
        assert input_text == "Что такое API?"
        assert language == "ru"
        return b"RIFF" + b"\x00" * 40

    monkeypatch.setattr(tts, "synthesize_speech", fake_synthesize)
    response = client.post("/tts/speech", json={"input": "Что такое API?", "language": "ru"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/wav")
    assert response.content.startswith(b"RIFF")


def test_tts_endpoint_rejects_oversized_text(client):
    response = client.post("/tts/speech", json={"input": "x" * 801, "language": "ru"})
    assert response.status_code == 422
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `apps/api-py/.venv/Scripts/python.exe -m pytest apps/api-py/tests/test_tts.py -q`

Expected: FAIL with 404.

- [ ] **Step 3: Implement direct-key and managed-gateway speech transport**

```py
async def synthesize_speech(input_text: str, language: str) -> bytes:
    settings = get_settings()
    own_key = secrets.get_secret("openai_api_key")
    body = {
        "model": "gpt-4o-mini-tts",
        "voice": "marin",
        "input": input_text,
        "response_format": "wav",
        "instructions": (
            "Говори естественно, спокойно и доброжелательно, как живой интервьюер. "
            "Без дикторской манеры."
            if language == "ru"
            else "Speak naturally and calmly like a real interviewer."
        ),
    }
    if own_key:
        url = "https://api.openai.com/v1/audio/speech"
        authorization = own_key
    else:
        license_key = _gateway_license_key()
        if not settings.skillcue_gateway_url or not license_key:
            raise AppError("Озвучка недоступна без подключения к AI.", 503, "tts_unavailable")
        url = f"{_gateway_root_url(settings.skillcue_gateway_url)}/gateway/tts/speech"
        authorization = license_key
        body = {"input": input_text, "language": language}
    response = await provider_adapter.get_client().post(
        url,
        headers={"Authorization": f"Bearer {authorization}"},
        json=body,
        timeout=30,
    )
    if response.status_code >= 400:
        raise parse_tts_error(response.status_code, response.text)
    return response.content
```

Import `get_settings`, `AppError`, `provider_adapter`, `secrets`, and the existing private
gateway helpers `_gateway_license_key` and `_gateway_root_url` explicitly in this service. Keep
all provider-specific error parsing in `parse_tts_error` so the router never exposes upstream
response bodies.

- [ ] **Step 4: Add the local endpoint and main-router registration**

```py
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
```

Register `tts.router` in `app/main.py` through a static import so PyInstaller discovers it.

- [ ] **Step 5: Run focused and packaged-backend tests**

Run:

```powershell
apps/api-py/.venv/Scripts/python.exe -m pytest apps/api-py/tests/test_tts.py apps/api-py/tests/test_gateway_fallback.py -q
pnpm --filter @interview/desktop build:backend
```

Expected: tests PASS and `apps/api-py/dist/skillcue-backend/skillcue-backend.exe` exists.

- [ ] **Step 6: Commit the packaged TTS transport**

```powershell
git add apps/api-py/app/services/tts.py apps/api-py/app/routers/tts.py apps/api-py/app/main.py apps/api-py/tests/test_tts.py
git commit -m "feat: expose natural speech to desktop"
```

### Task 3: Cached desktop speech hook with deterministic fallback

**Files:**
- Create: `apps/desktop/src/lib/questionSpeech.ts`
- Create: `apps/desktop/src/lib/questionSpeech.test.ts`
- Create: `apps/desktop/src/hooks/useQuestionSpeech.ts`
- Modify: `apps/desktop/src/lib/api.ts`
- Modify: `apps/desktop/src/components/prepare/SmokeInterviewView.tsx:520-565`
- Modify: `apps/desktop/src/lib/i18n/ru.ts`
- Modify: `apps/desktop/src/lib/i18n/en.ts`
- Modify: `apps/desktop/src/styles/prepare.css`

**Interfaces:**
- Consumes: local `/tts/speech`, known current/next mock question, and `speechSynthesis.getVoices()` fallback.
- Produces: `useQuestionSpeech()` with `play`, `stop`, `prefetch`, `state`, and `usedFallback`.

- [ ] **Step 1: Write failing cache-key and voice-ranking tests**

```ts
import { describe, expect, it } from 'vitest';
import { questionSpeechCacheKey, selectFallbackVoice } from './questionSpeech';

const voice = (
  name: string,
  lang: string,
  localService: boolean,
): SpeechSynthesisVoice => ({
  default: false,
  lang,
  localService,
  name,
  voiceURI: name,
});

describe('question speech helpers', () => {
  it('normalizes equivalent text into one cache key', () => {
    expect(questionSpeechCacheKey('  Что   такое API? ', 'ru'))
      .toBe(questionSpeechCacheKey('Что такое API?', 'ru'));
  });

  it('prefers a Russian natural/online voice over the arbitrary first voice', () => {
    const voices = [
      voice('Microsoft Irina Desktop', 'ru-RU', true),
      voice('Microsoft Svetlana Online (Natural)', 'ru-RU', false),
    ];
    expect(selectFallbackVoice(voices, 'ru')?.name).toContain('Natural');
  });

  it('never selects an English voice for Russian when Russian exists', () => {
    const voices = [
      voice('English Natural', 'en-US', false),
      voice('Русский голос', 'ru-RU', true),
    ];
    expect(selectFallbackVoice(voices, 'ru')?.lang).toBe('ru-RU');
  });
});
```

- [ ] **Step 2: Run the helper test and verify failure**

Run: `pnpm --filter @interview/desktop test -- src/lib/questionSpeech.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement stable cache keys and fallback ranking**

```ts
export function questionSpeechCacheKey(text: string, language: 'ru' | 'en'): string {
  return ['gpt-4o-mini-tts', 'marin', language, text.replace(/\s+/g, ' ').trim()].join('|');
}

export function selectFallbackVoice(
  voices: SpeechSynthesisVoice[],
  language: 'ru' | 'en',
): SpeechSynthesisVoice | null {
  const prefix = language === 'ru' ? 'ru' : 'en';
  const matching = voices.filter((voice) => voice.lang.toLowerCase().startsWith(prefix));
  const score = (voice: SpeechSynthesisVoice) => {
    const name = voice.name.toLowerCase();
    return (name.includes('natural') ? 100 : 0)
      + (name.includes('online') ? 40 : 0)
      + (!voice.localService ? 20 : 0)
      + (voice.default ? 5 : 0);
  };
  return matching.sort((a, b) => score(b) - score(a))[0] ?? null;
}
```

- [ ] **Step 4: Implement managed playback, cache, prefetch, and fallback hook**

`api.synthesizeSpeech(input, language)` must return a Blob after authenticated fetch. The hook
keeps an LRU map of at most 20 object URLs, revokes evicted URLs, and uses one
`HTMLAudioElement`. `play` first uses cached/managed WAV; on fetch or playback failure it creates
a `SpeechSynthesisUtterance`, selects `selectFallbackVoice`, sets `rate = 0.96`, and speaks.
`prefetch` downloads without playback and ignores errors.

```ts
export type QuestionSpeechState = 'idle' | 'loading' | 'playing' | 'error';

export interface QuestionSpeechController {
  state: QuestionSpeechState;
  usedFallback: boolean;
  play(text: string, language: 'ru' | 'en'): Promise<void>;
  stop(): void;
  prefetch(text: string | undefined, language: 'ru' | 'en'): void;
}
```

Replace `SpeakButton`'s direct Web Speech code with the hook. Prefetch the next question whenever
its ID/text changes. Show loading spinner, stop state, retry title, and a small `AI-озвучка`
disclosure next to the control.

- [ ] **Step 5: Run tests, typecheck, and build**

Run:

```powershell
pnpm --filter @interview/desktop test -- src/lib/questionSpeech.test.ts
pnpm --filter @interview/desktop typecheck
pnpm --filter @interview/desktop build
```

Expected: PASS.

- [ ] **Step 6: Commit natural desktop speech**

```powershell
git add apps/desktop/src/lib/questionSpeech.ts apps/desktop/src/lib/questionSpeech.test.ts apps/desktop/src/hooks/useQuestionSpeech.ts apps/desktop/src/lib/api.ts apps/desktop/src/components/prepare/SmokeInterviewView.tsx apps/desktop/src/lib/i18n/ru.ts apps/desktop/src/lib/i18n/en.ts apps/desktop/src/styles/prepare.css
git commit -m "feat: use natural cached interview speech"
```

### Task 4: Full verification, gateway deployment, and SkillCue 0.0.16 release

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/lib/releaseNotes.ts`
- Modify: `CHANGELOG.md`
- Verify: all files named in the four approved implementation plans

**Interfaces:**
- Consumes: completed Plans 1–4, SSH deployment tooling, GitHub release workflow, and public updater assets.
- Produces: deployed gateway and public `v0.0.16` installer/blockmap/`latest.yml`.

- [ ] **Step 1: Run the complete automated regression suite**

Run:

```powershell
pnpm --filter @interview/shared build
pnpm --filter @interview/desktop test
pnpm --filter @interview/desktop lint
pnpm --filter @interview/desktop typecheck
pnpm --filter @interview/desktop build
apps/api-py/.venv/Scripts/python.exe -m pytest apps/api-py/tests -q
pnpm --filter @interview/api build
node --test apps/api/dist/gateway/gateway-tts.service.test.js apps/api/dist/gateway/gateway-stt.service.test.js apps/api/dist/gateway/gateway-stt-quota.util.test.js
```

Expected: every command exits 0. Record any pre-existing unrelated lint failure separately; do
not waive failures in files changed by this release.

- [ ] **Step 2: Build and smoke-test the packaged application**

Run:

```powershell
pnpm --filter @interview/desktop dist:full
powershell -ExecutionPolicy Bypass -File scripts/smoke-packaged.ps1
```

Expected: frozen backend health/auth checks PASS; `apps/desktop/release/SkillCue-Setup.exe`,
its `.blockmap`, and `latest.yml` exist.

- [ ] **Step 3: Perform the Windows behavior smoke checklist**

Verify all of the following in the packaged app:

1. Three rapid spoken questions plus three `Ctrl+Enter` presses end on the third answer.
2. No transcript final disappears and genuine empty audio alone shows `Нет новой реплики`.
3. Empty overlay space passes clicks; visible controls still work.
4. Tooltips and the ellipsis menu remain fully inside the overlay.
5. `Ctrl+Shift+H` hides the overlay without showing the main window.
6. Russian recap contains no English prose headings.
7. `Разобрать сессию` persists and reloads evidence-based weak topics.
8. Resume import shows a spinner and cannot be submitted twice.
9. Title-bar button hover backgrounds stop at the divider and inputs use indigo focus.
10. Managed Russian question speech plays naturally; simulated TTS failure uses local fallback.

- [ ] **Step 4: Deploy gateway before the desktop tag**

Run the repository deployment tool from `C:\dev\interview` using the configured SSH key and then
verify service health:

```powershell
apps/api-py/.venv/Scripts/python.exe apps/api/deploy/deploy.py
ssh -i C:\dev\secret\id_ed25519 root@109.172.47.103 "systemctl is-active skillcue-gateway && curl -fsS http://127.0.0.1:8787/health"
```

Expected: service is `active` and health returns success. Issue a temporary licensed smoke request
and verify `/gateway/tts/speech` returns HTTP 200, `Content-Type: audio/wav`, and bytes beginning
with `RIFF`:

```powershell
ssh -i C:\dev\secret\id_ed25519 root@109.172.47.103 'set -a; . /opt/skillcue/gateway.env; set +a; KEY=$(curl -fsS -X POST http://127.0.0.1:8787/gateway/issue -H "x-admin-secret: $GATEWAY_ADMIN_SECRET" -H "Content-Type: application/json" -d ''{"email":"tts-smoke@local","days":1,"plan":"trial","tokensMonth":10000}'' | python3 -c "import json,sys; print(json.load(sys.stdin)[''key''])"); CODE=$(curl -sS -w "%{http_code}" -D /tmp/skillcue-tts.headers -o /tmp/skillcue-tts.wav -X POST http://127.0.0.1:8787/gateway/tts/speech -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d ''{"input":"Что такое API?","language":"ru"}''); test "$CODE" = 200; grep -qi "^content-type: audio/wav" /tmp/skillcue-tts.headers; test "$(head -c 4 /tmp/skillcue-tts.wav)" = RIFF; rm -f /tmp/skillcue-tts.headers /tmp/skillcue-tts.wav'
```

- [ ] **Step 5: Set version and write Russian release notes**

Change desktop package version from `0.0.15` to `0.0.16`. Add the first release-note entry:

```ts
{
  version: '0.0.16',
  date: '2026-08-02',
  title: 'Надёжный live-оверлей и автоматические обновления',
  points: [
    'Повторный Ctrl+Enter всегда отвечает на самый новый вопрос и не теряет распознанные реплики.',
    'Прозрачные области оверлея больше не блокируют мышь, а меню и подсказки не обрезаются.',
    'Итоги сессии стали русскими; AI-разбор сохраняет сильные и слабые темы для дальнейшей подготовки.',
    'Обновления устанавливаются и перезапускают SkillCue автоматически после завершения live-сессии.',
    'Вопросы мок-интервью озвучиваются естественным AI-голосом с локальным резервным вариантом.',
  ],
},
```

Add the same concise points under `0.0.16` in `CHANGELOG.md`.

- [ ] **Step 6: Rebuild versioned artifacts and commit the release metadata**

Run:

```powershell
pnpm --filter @interview/desktop dist:full
Select-String -Path apps/desktop/release/latest.yml -Pattern 'version: 0.0.16'
git add apps/desktop/package.json apps/desktop/src/lib/releaseNotes.ts CHANGELOG.md
git commit -m "chore(release): v0.0.16"
```

Expected: the version assertion matches and the commit succeeds.

- [ ] **Step 7: Audit the exact release tree before pushing**

Run:

```powershell
git status --short
git log --oneline --decorate -20
git diff origin/main...HEAD --check
```

Expected: no unstaged release files, no generated `apps/api-py/build` directory staged, no secret
files, and no whitespace errors. Any remaining untracked/generated artifacts stay uncommitted.

- [ ] **Step 8: Tag, push, and wait for the public release workflow**

Run:

```powershell
git tag v0.0.16
git push origin main
git push origin v0.0.16
gh run list --workflow=release.yml --limit 1
```

Watch the returned run until success with `gh run watch <run-id> --exit-status --interval 25`.

Expected: GitHub Actions succeeds and publishes to `GalievGleb/ScillCue`.

- [ ] **Step 9: Verify updater assets and transition behavior**

Run:

```powershell
$latest = Invoke-WebRequest -UseBasicParsing https://github.com/GalievGleb/ScillCue/releases/latest/download/latest.yml
$latest.Content | Select-String 'version: 0.0.16'
Invoke-WebRequest -Method Head -UseBasicParsing https://github.com/GalievGleb/ScillCue/releases/latest/download/SkillCue-Setup.exe
```

Expected: latest version is 0.0.16 and installer returns HTTP 200. Confirm the installed 0.0.15
downloads it; one normal exit installs that transition build. From 0.0.16 onward, simulate a later
download and verify immediate silent relaunch or defer-until-live-end without any extra button.

## Plan 4 completion checkpoint

The release is complete only when the gateway is healthy, public `latest.yml` is 0.0.16, the
installer is downloadable, all automated checks pass, and the packaged Windows smoke checklist
passes without a manual application download.
