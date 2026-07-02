# SkillCue Landing - 5 UI/UX Iterations

## Iteration 1 - Structure

Checked every page block for product purpose.

Fixes:
- Kept the landing short: hero, live demo, product path, three feature cards, pricing, FAQ, final CTA.
- Preserved the full prototype separately in `landing/index.prototype-full.html`.
- Removed prototype-style supporting sections from the actual landing.

## Iteration 2 - Hero

Checked headline, subtext, CTA, and product visual.

Fixes:
- Simplified the hero around one moment: interviewer question -> SkillCue cue -> context badges.
- Changed the main CTA to the stronger product action: "Разобрать вакансию бесплатно".
- Rewrote the hero copy around user pain: likely questions, risk, and a short cue during the interview.

## Iteration 3 - Live Demo

Checked question quality, answer quality, overlay readability, and context pills.

Fixes:
- Replaced weak placeholder text with a realistic API testing question.
- Shortened the answer into a real live cue instead of a long explanation.
- Removed unnecessary visual clutter and kept only useful context: vacancy, resume, readiness.

## Iteration 4 - Content And Sections

Checked timeline, feature cards, pricing, FAQ, final CTA, and footer.

Fixes:
- Replaced internal handoff copy with user-facing copy.
- Changed English status labels in the product path to Russian labels where they were distracting.
- Increased secondary text contrast across cards, FAQ, pricing, and timeline.
- Made the footer production-style instead of "MVP/prototype" wording.

## Iteration 5 - Responsive QA

Checked 1440 desktop, full-page desktop, and 390 mobile.

Fixes:
- Removed mobile horizontal overflow in the source layout.
- Verified real mobile viewport through CDP: `clientWidth=390`, `scrollWidth=390`.
- Tightened mobile typography, demo card width, cue wrapping, and answer line-height.
- Re-ran CSS, anchor, HTTP, and visual screenshot checks.

