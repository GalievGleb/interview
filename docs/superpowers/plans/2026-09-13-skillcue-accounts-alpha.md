# SkillCue Accounts Alpha Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google-first and verified-email SkillCue accounts, account-owned subscriptions,
a two-device limit, password recovery, and local backup controls to Alpha without changing Stable.

**Architecture:** A dedicated NestJS account service uses PostgreSQL and Resend. Device
sessions use opaque refresh tokens and installation IDs held by Electron `safeStorage`.
The Alpha renderer gets an account client and settings UI; the existing offline-license
path stays available during migration.

**Tech Stack:** TypeScript, NestJS 11, Prisma/PostgreSQL, React, Electron `safeStorage`,
Google OpenID Connect with desktop PKCE, Resend HTTPS API, Vitest/node:test.

**Spec:** `docs/specs/skillcue-accounts-alpha.md`

## Global Constraints

- Work only in the existing Alpha worktree/branch; do not publish Stable.
- Never commit the Resend API key, passwords, codes, refresh tokens, or production JWT secrets.
- Keep existing signed license activation working throughout the Alpha rollout.
- Use test-first red/green cycles for each behavioral change.
- Do not deploy an Alpha client that points at an unavailable account API.

---

### Task 1: Transactional mail boundary

**Files:**
- Create: `apps/api/src/mail/resend-mail.client.ts`
- Create: `apps/api/src/mail/mail.module.ts`
- Test: `apps/api/src/mail/resend-mail.client.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `RESEND_API_KEY`, `AUTH_MAIL_FROM`, injected `fetch`.
- Produces: `ResendMailClient.sendVerificationCode(email, code, purpose)`.

- [ ] Write tests proving the client sends the exact Resend request, rejects missing server
  configuration, and never returns or logs the API key.
- [ ] Run the isolated tests and observe failure because the client does not exist.
- [ ] Implement the minimal client with timeout, generic provider errors, and Russian HTML/text.
- [ ] Run the isolated tests and the API TypeScript build.

### Task 2: Verified accounts and password recovery

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260913_accounts_alpha/migration.sql`
- Create: `apps/api/src/auth/auth-code.service.ts`
- Test: `apps/api/src/auth/auth-code.service.test.ts`
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/auth.controller.ts`
- Modify: `apps/api/src/auth/auth.module.ts`
- Modify: `apps/api/src/auth/dto/auth.dto.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `ResendMailClient`, Prisma `User` and `EmailChallenge` records.
- Produces: request/confirm verification and password-reset endpoints plus verified login.

- [ ] Write failing tests for normalized email, code expiry, attempt exhaustion, one-time use,
  generic reset responses, and unverified-login rejection.
- [ ] Run the tests and confirm expected behavioral failures.
- [ ] Add the Prisma fields/table and minimal auth-code service.
- [ ] Wire the controller/service DTOs and shared response contracts.
- [ ] Generate Prisma client, run tests, and build the API.

### Task 3: Two-device session enforcement

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/prisma/migrations/20260913_accounts_alpha/migration.sql`
- Create: `apps/api/src/auth/device-session.service.ts`
- Test: `apps/api/src/auth/device-session.service.test.ts`
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/auth.controller.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: verified user ID, random installation ID, device label.
- Produces: opaque refresh session, `GET /auth/devices`, and
  `DELETE /auth/devices/:sessionId` with a maximum of two active sessions.

- [ ] Write failing tests for first/second device success, third-device rejection, refresh
  rotation, revocation, and same-installation reuse.
- [ ] Run tests and confirm they fail because session enforcement is absent.
- [ ] Implement hashed device/session storage and JWT session binding.
- [ ] Run tests, Prisma validation, and API build.

### Task 3A: Google-first desktop sign-in

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/src/auth/google-identity.service.ts`
- Test: `apps/api/src/auth/google-identity.service.test.ts`
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/auth.controller.ts`
- Modify: `apps/api/src/auth/auth.module.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/desktop/electron/googleOAuth.ts`
- Test: `apps/desktop/electron/googleOAuth.test.ts`

**Interfaces:**
- Consumes: `GOOGLE_OAUTH_CLIENT_ID`, Google ID token, random installation ID, device label.
- Produces: a linked verified SkillCue profile and the same two-device session used by email login.

- [ ] Write failing tests for ID-token claim validation, immutable `sub` linking, verified-email
  linking, PKCE S256, state rejection, timeout, and loopback-only callback handling.
- [ ] Run tests and confirm the Google boundary is absent.
- [ ] Implement server-side Google token verification and desktop system-browser PKCE flow with
  only `openid email profile` scopes.
- [ ] Run auth/Electron tests, Prisma validation, and builds.

### Task 4: Account-owned and duplicate-safe subscriptions

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/prisma/migrations/20260913_accounts_alpha/migration.sql`
- Modify: `apps/api/src/subscriptions/subscriptions.service.ts`
- Modify: `apps/api/src/billing/billing.service.ts`
- Test: `apps/api/src/subscriptions/subscriptions.service.test.ts`

**Interfaces:**
- Consumes: verified normalized email, verified payment event, plan, paid period.
- Produces: one effective subscription per account with additive renewal and idempotent events.

- [ ] Write failing tests for additive renewal, upgrade, duplicate webhook replay, and a
  purchase-before-registration pending entitlement.
- [ ] Run tests and confirm current overwrite behavior fails the renewal test.
- [ ] Implement pending entitlements and additive account activation.
- [ ] Run billing/subscription tests and API build.

### Task 5: Alpha desktop account client and secure token storage

**Files:**
- Create: `apps/desktop/electron/accountSessionStore.ts`
- Test: `apps/desktop/electron/accountSessionStore.test.ts`
- Modify: `apps/desktop/electron/main.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts`
- Create: `apps/desktop/src/lib/accountApi.ts`
- Test: `apps/desktop/src/lib/accountApi.test.ts`

**Interfaces:**
- Consumes: `SKILLCUE_ACCOUNT_API_URL`, Electron `safeStorage`, account API contracts.
- Produces: renderer-safe register/login/verify/reset/devices/logout operations with automatic
  access-token refresh; renderer never receives a refresh token.

- [ ] Write failing tests for encrypted persistence, corrupt-state recovery, Alpha URL
  selection, refresh rotation, and Stable fail-closed behavior.
- [ ] Run the tests and confirm missing implementation failures.
- [ ] Implement the Electron session boundary and typed renderer client.
- [ ] Run Electron tests, renderer tests, typecheck, and desktop build.

### Task 6: Alpha account and device UI

**Files:**
- Create: `apps/desktop/src/components/AccountCard.tsx`
- Create: `apps/desktop/src/components/AccountCard.test.tsx`
- Modify: `apps/desktop/src/pages/SettingsPage.tsx`
- Modify: `apps/desktop/src/components/PlanPicker.tsx`
- Modify: `apps/desktop/src/components/LicenseCard.tsx`
- Modify: `apps/desktop/src/lib/i18n/ru.ts`
- Modify: `apps/desktop/src/lib/i18n/en.ts`

**Interfaces:**
- Consumes: account IPC API, account/subscription/device state.
- Produces: registration, verification, login, reset, sign-out, device list/revoke, and
  account-first checkout presentation in Alpha.

- [ ] Write failing interaction tests for every form state and the third-device recovery flow.
- [ ] Run tests and verify failure because the account surface is absent.
- [ ] Implement accessible forms and retain the legacy license card as an Alpha migration path.
- [ ] Run component tests, typecheck, and desktop build.

### Task 7: Local backup before reinstall

**Files:**
- Create: `apps/desktop/electron/backupService.ts`
- Test: `apps/desktop/electron/backupService.test.ts`
- Modify: `apps/desktop/electron/main.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts`
- Modify: `apps/desktop/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: approved SkillCue data directories and renderer-owned local settings.
- Produces: versioned backup archive export and validated import preview; import requires an
  explicit final user action and creates a rollback copy.

- [ ] Write failing tests for path containment, manifest versioning, corrupt archives, and
  rollback-copy creation.
- [ ] Run tests and confirm failure before implementation.
- [ ] Implement export plus non-destructive import preview; wire explicit import confirmation.
- [ ] Run backup tests and packaged Alpha smoke.

### Task 8: Dedicated account deployment and Alpha acceptance

**Files:**
- Create: `apps/api/src/account-main.ts`
- Create: `apps/api/tsconfig.account.json`
- Create: `apps/api/deploy/skillcue-account.service`
- Modify: `apps/api/deploy/deploy.py`
- Modify: `apps/api/deploy/setup-web.sh`
- Modify: `apps/api/deploy/test_deploy_env.py`
- Create: `tools/account_acceptance.py`
- Modify: `RELEASE_BUILD_GUIDE.md`

**Interfaces:**
- Consumes: PostgreSQL, production JWT/code/Resend secrets, HTTPS nginx route.
- Produces: isolated account API health/auth routes and a ten-run Alpha acceptance report.

- [ ] Write failing deploy and acceptance tests for secret presence, localhost-only binding,
  health, verification, two-device enforcement, reset, subscription visibility, and redaction.
- [ ] Run tests and confirm deployment support is missing.
- [ ] Implement the standalone account entry point, systemd unit, DB migration, and nginx route.
- [ ] Deploy only after SSH authentication is available; verify HTTPS and send a real code.
- [ ] Build/install Alpha and run ten consecutive acceptance passes before considering Dev.
