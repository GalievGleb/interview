# SkillCue Accounts Alpha Specification

## Goal

Introduce a production-shaped account system in the Alpha channel without changing the
public Stable channel or invalidating existing offline license keys.

## User flows

1. A user normally signs in with Google in the system browser. The desktop app uses the
   installed-application OAuth flow with PKCE and a loopback callback; Google credentials
   are never entered inside SkillCue.
2. The account service validates Google's signed ID token, verified email, issuer, audience,
   and expiry before creating or linking a SkillCue profile.
3. Email plus password remains a fallback. SkillCue sends a six-digit verification code from
   `no-reply@skill-cue.ru`, and that account becomes usable only after confirmation.
4. A verified user can sign in with either linked method, refresh a session, sign out, request a password reset,
   confirm a reset code, and choose a new password.
5. A user can view active devices, use the account on at most two devices, and revoke a
   device. The current installation uses a random installation identifier rather than a
   covert hardware fingerprint.
6. A subscription belongs to the account, not to one installation. It therefore works on
   either of the two active devices.
7. Existing signed SkillCue license keys continue to work during the Alpha migration.
8. Before reinstalling, users can export local data; import remains explicit and never
   overwrites data without confirmation.

## Security rules

- Normalize email addresses with trim plus lowercase before lookup.
- Store password hashes with bcrypt cost 12; never store passwords or verification codes.
- Store verification codes as HMAC-SHA256 digests using `AUTH_CODE_SECRET`.
- Codes expire after 10 minutes, become unusable after success, and allow five attempts.
- A new code request is rate-limited and returns a generic response where account
  enumeration would otherwise be possible.
- Access tokens live for 15 minutes. Refresh tokens are random opaque values and only
  SHA-256 hashes are stored per device session.
- Revoke the oldest inactive device only through an explicit user action; a third device
  sign-in fails with a clear `DEVICE_LIMIT_REACHED` response and the device list.
- Store the desktop refresh token with Electron `safeStorage`; renderer localStorage must
  never contain it.
- Resend credentials exist only in server environment variables. Client bundles and Git
  history must never contain them.
- Google sign-in requests only `openid email profile`, uses the system browser, PKCE S256,
  a random `state`, and `127.0.0.1` loopback on a random port. The server accepts no Google
  identity until the ID token signature and claims have been verified against
  `GOOGLE_OAUTH_CLIENT_ID`.
- Google identities are keyed by the immutable Google `sub`, not by mutable profile data.
- The Alpha client talks to an HTTPS account API. Stable retains its current behavior.

## Subscription rules

- One account has one effective subscription and up to two active device sessions.
- An active account subscription produces a 24-hour signed desktop entitlement. Electron
  installs it into a separate local slot, so it never exposes the key to the renderer and
  never overwrites a customer's existing manual license. Reissued entitlements keep one
  stable account quota identity across both allowed devices.
- Duplicate payment notifications are idempotent by provider and external payment ID.
- A new purchase for the same plan extends from the later of `now` or the current period
  end. It does not create a second simultaneously shareable entitlement.
- An upgrade activates the higher plan immediately; payment-provider truth is checked
  server-side before activation.
- A purchase made for an email before registration is held as a pending entitlement and
  attached only after that email is verified.

## Rollout

- Build and test in the existing Alpha worktree and identity.
- Deploy the account API separately from the existing gateway so overlay/STT traffic is
  unaffected.
- Enable account UI only in Alpha until ten consecutive account/device/payment smoke runs
  pass. Dev may consume the same API after Alpha validation. Stable stays unchanged.
