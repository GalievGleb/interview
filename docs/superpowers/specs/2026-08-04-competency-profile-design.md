# Competency Profile Design

## Goal

Turn «Личный прогресс» into a spacious competency profile that distinguishes self-assessment from evidence collected in interview analyses and never treats unasked or irrelevant topics as weaknesses.

## Approved experience

- The first visit shows the selected professional trajectory and a separate voluntary invitation to self-assessment.
- Self-assessment opens only after an explicit click and states that it is not confirmed interview evidence.
- The user chooses one specialization. Its core topics are always in scope; optional adjacent topics enter the map only when selected.
- Missing interview evidence is shown as «Пока не проверялось», not as a gap.
- Technical and HR evidence remain separate.
- An exact technical score `/100` is shown only when `technical.evidenceCount >= 3` and `technical.confidence >= 0.55`; otherwise the UI says «Предварительно».
- Recent analyzed sessions form a spacious evidence history below the map.

## Data flow

The page loads the existing `/sessions/development-profile` aggregate. Professional scope and voluntary answers use the versioned local key `skillcue.growth-profile.v1`; these values define what to display but never overwrite AI evidence. Topic matching combines only selected core/optional topics with existing strength and focus evidence.

## Release constraints

Release as desktop `0.0.22` on top of `0.0.21`. Preserve the final HH flow already present in `main`, keep the updater target `GalievGleb/SkillCue`, and do not include unrelated dirty-worktree changes.
