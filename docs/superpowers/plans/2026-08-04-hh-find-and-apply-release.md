# SkillCue applications release plan

## Goal

Publish SkillCue 0.0.24 with a verified HH find-and-apply flow, a current HH recruiter-chat integration, and complete vacancy-list visibility.

## Required behavior

- HH login uses the saved local browser profile and passwordless email/code flow.
- The primary HH action saves settings, scans the selected platform, and immediately starts the queue.
- Only real screening questions inside the response form block an application.
- The selected resume is matched against both compact and verbose HH titles.
- A cover letter is opened, filled, verified, and submitted through the current HH response modal.
- Recruiter polling uses `https://hh.ru/applicant/negotiations` in a dedicated browser tab.
- Chat messages are read from the Chatik iframe; a reply is sent only when the newest message is incoming.
- A reply counts only after HH renders the matching new outgoing message.
- Every found vacancy, including skipped items and its reason, remains visible in the UI.

## Verification

- [x] Desktop unit and behavior tests.
- [x] Renderer and Electron TypeScript checks.
- [x] Production desktop build.
- [x] One controlled real HH application confirmed as sent.
- [x] Live recruiter-chat scan confirmed three active discussions and zero unanswered incoming messages.
- [x] Full repository checks after rebasing onto the latest `main`.
- [ ] Publish tag and installer for 0.0.24.
