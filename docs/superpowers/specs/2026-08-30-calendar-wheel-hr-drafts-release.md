# Calendar Wheel and HR Drafts Release Specification

## User-visible requirements

- A vertical mouse-wheel gesture made while the pointer is over the weekly calendar must scroll the surrounding Calendar page.
- The weekly grid itself must remain vertically fixed; its existing horizontal overflow remains available on narrow windows.
- Every pending HR dialog decision must show an editable answer draft before the user sends anything.
- Existing persisted HR decisions created by older builds must receive drafts too.
- Draft generation must never send a message. Sending remains an explicit user action.
- If a personal fact is unavailable, the draft must remain visibly incomplete rather than inventing the fact.
- After verification, update the Dev installation, stable release artifacts, deployed gateway/site, and release metadata consistently.

## Safety constraints

- Do not send real HH messages or applications during tests.
- Do not expose HH messages, résumé contents, cookies, API keys, or deployment credentials.
- Preserve all unrelated dirty-worktree changes.
- Do not use paid GitHub-hosted build runners; produce release artifacts locally.

