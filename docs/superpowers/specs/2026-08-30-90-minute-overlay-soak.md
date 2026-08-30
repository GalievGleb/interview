# 90-Minute Overlay Reliability Specification

## Objective

Prove that a SkillCue technical interview can remain usable for at least 90 minutes: transcription continues, Ctrl+Enter can still produce an answer, the overlay remains responsive, and recoverable provider/network disconnects do not permanently end the session.

## Acceptance Criteria

- No SkillCue application timer or entitlement silently stops a Dev/Max live session at 60 or 90 minutes.
- Trial and monthly-plan limits remain explicit and are reported accurately; no test bypass is introduced into stable builds.
- A forced STT transport disconnect at the provider lifetime boundary reconnects without restarting the interview or losing the already accumulated transcript.
- After simulated elapsed times beyond 60 and 90 minutes, a fresh final transcript can still trigger a fresh answer.
- A wall-clock installed-Dev soak keeps one interview session alive and records periodic transcription/answer latency, transport reconnects, memory, and failures.
- Automated verification covers the lifetime boundary and recovery path deterministically so the regression is caught without waiting an hour in every test run.

## Non-Goals

- Guaranteeing availability through loss of electricity, OS termination, or an indefinitely unavailable network/provider.
- Removing legitimate Trial or paid-plan monthly limits.
- Deploying, publishing, committing, or changing production credentials as part of this verification.

## Evidence Required

- Source-level inventory of every relevant timer, plan limit, provider limit, and reconnect policy.
- RED/GREEN automated tests for any behavior changed.
- Installed-Dev smoke or soak output showing successful work after the lifetime boundary.
- Exact caveats and remaining external limits reported to the user.
