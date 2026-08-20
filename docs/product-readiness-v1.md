# SkillCue Product Readiness v1

## Goal

A new customer can download the current stable installer, activate a paid key,
open the overlay, and use HH automation without discovering preventable failures
during an interview or silently losing vacancies.

## Product requirements

1. A public tag may publish only when the tag, desktop package version, release
   notes, and changelog describe the same stable semantic version.
2. Overlay/provider readiness is checked silently at application startup and
   before a saved interview. The customer sees a normal warning only when the
   check fails; there is no debug or "test overlay" UI in stable builds.
3. Checkout success always preserves a visible, copyable activation key and a
   manual activation path when the `skillcue://` deep link is unavailable.
4. First use presents one compact product path (resume, HH, live) inside the
   normal Home page; it is not a separate debug/onboarding application.
5. HH keeps up to 5,000 discovered vacancies, retries transient failures, and
   produces a privacy-safe diagnostic archive without opening HH.
6. Optional operational telemetry contains event categories, versions, counts,
   and error codes only. It never contains cookies, tokens, resume text,
   employer answers, transcripts, or screen/audio content.
7. Developer smoke scripts, fixtures, and generated data stay in `tools/`, test
   files, or CI and are never packaged as stable runtime features.
8. Real payment creation and public release publication require a separate
   explicit confirmation because they change external financial/public state.
