# Google login and overlay gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make real Google loopback sign-in work, prevent guest overlay opening, and offer Google login on Home.
**Architecture:** Preserve the bound loopback port when parsing the redirect. Centralize an Alpha account gate in Electron before revealing the overlay and before capture/hotkeys. Reuse AccountCard with a shared Google-branded button on Home and Settings; keep current app styling.
**Tech Stack:** Electron, React, TypeScript, Vitest, Node HTTP.
**Spec:** Current user request: Google callback reports success but application errors; improve Google icon; no overlay before authentication; Home should prompt Google sign-in.

## Global Constraints

- Work in existing feature branch. Preserve untracked `apps/api-py/$db`.
- Alpha only for the access gate; no stable/Dev regression or site redesign.
- Never log OAuth code, state, verifier, ID tokens, or refresh tokens.
- Browser callback must not claim full application sign-in before account exchange succeeds.

## Investigation update

The real loopback test reproduced `GOOGLE_OAUTH_STATE_INVALID`: listener parsing omitted its bound port. A separate harmless Google token request with a fake authorization code established a second blocker: HTTP 400 `client_secret is missing`. The existing Desktop OAuth client secret is masked in Cloud Console and absent from project configuration; no credentials were logged or committed.

The Alpha builder now reads an installed-app JSON from ignored `.google_oauth_client.json` at repository root or `SKILLCUE_GOOGLE_OAUTH_CONFIG`. It refuses web-server credentials and incomplete client metadata. This is Google's **installed/public-client** credential, distributed as native client metadata together with the client ID, not an API key or account credential. Never reuse a confidential web/server secret here. PKCE is preserved; the secret is sent only to Google's HTTPS token endpoint, never in the browser URL or renderer API.

References: https://developers.google.com/identity/protocols/oauth2/native-app and https://developers.google.com/identity/branding-guidelines. Google button artwork: https://developers.google.com/static/identity/images/g-logo.png.

Pending user input: add an additional client secret without deleting the existing one, and save the installed-client JSON to Downloads. Until then the installer is intentionally not rebuilt or installed; the previous installed Alpha is unchanged.

### Task 1: Real loopback callback

Files: `apps/desktop/electron/googleOAuth.ts`, `googleOAuth.test.ts`.
- [ ] Add real HTTP listener test: openExternal reads `redirect_uri` and state from authorization URL, fetches that callback with fake code, and mock only external Google token response. Expect `{idToken:'test-id-token'}`. Before fix it fails `GOOGLE_OAUTH_STATE_INVALID`.
- [ ] Construct callback URL with bound server port, not portless localhost. Keep exact origin/path/state/PKCE checks. Replace browser text with “Ответ Google получен. Вернитесь в SkillCue — приложение завершает вход.”
- [ ] Run `pnpm exec vitest run electron/googleOAuth.test.ts`; test wrong-state and token rejection too.

### Task 2: Native overlay authorization

Files: new `apps/desktop/electron/overlayAccountGate.ts` and test; `electron/main.ts`.
- [ ] Test gate with Alpha null/guest/authenticated states and Dev/stable states. Observable effects: denied request calls account navigation, never reveal callback; permitted request reveals once.
- [ ] Implement `runWithOverlayAccount(channel, state, reveal, requireLogin): boolean`: Alpha denies unless authenticated and user exists; other channels retain behavior.
- [ ] Apply before overlay show/toggle/event/tray/hotkeys and screenshot. On signed-out account event hide existing overlay and stop its session through existing renderer stop message.
- [ ] Verify all opening paths, including hotkeys, use the guard; run Electron typecheck/tests.

### Task 3: Home sign-in and Google button

Files: `src/components/AccountCard.tsx`, new `GoogleSignInButton.tsx`, `src/pages/HomePage.tsx`, relevant component tests.
- [ ] Add test for Home-mode AccountCard: while guest show Google CTA, after successful login hide prompt; show helpful stable error text on failed OAuth.
- [ ] Add shared 4-color Google SVG and restrained light button, existing font, focus outline, disabled/busy state. Preserve other page sections and dark/light themes.
- [ ] Render `<AccountCard homePrompt />` above Home dashboard; do not show it for signed-in users or unavailable legacy clients.
- [ ] Run component tests and renderer typecheck.

### Task 4: Deliver Alpha

- [ ] Run targeted OAuth/account/overlay tests, typechecks and diff check. Commit scoped files.
- [ ] Build Alpha with existing public Google client ID/account URL; install without changing user data.
- [ ] Verify installed guest Home CTA, blocked overlay IPC + native hotkey paths, account screen and readable layout. Real Google consent may require user's repeat; do not simulate a successful real login.
- [ ] Report installed version, tested checks and remaining real-account verification.
