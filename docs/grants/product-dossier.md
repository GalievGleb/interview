# SkillCue Product Dossier

## One-line pitch

SkillCue turns a specific job vacancy into a personalized interview preparation plan, skill-gap map, and vacancy-specific mock interview for Russian-speaking job seekers.

## Current stage

SkillCue is a working pre-launch Windows MVP. It has no external users or revenue yet. The immediate validation goal is to recruit 10 external testers, measure completed preparation sessions, and collect structured qualitative feedback.

## Founder and legal status

SkillCue is built and owned by solo founder and developer Gleb Galiev. The founder currently lives in Da Lat, Vietnam. The initial market is Russian-speaking job seekers, and Russian subscription payments are accepted under the founder's Russian self-employed status. SkillCue is not represented as a Vietnamese company or a venture-backed startup.

## Problem

Candidates often prepare from generic question lists that ignore the role, company requirements, and their own experience. General-purpose chat tools can help, but the user must design prompts, organize results, evaluate answers, and track weak areas manually. This is especially difficult for junior and middle-level candidates preparing under time pressure.

## Solution

SkillCue provides one structured preparation workflow:

1. Import a job description and relevant experience.
2. Extract the role's skills, risks, and likely interview topics.
3. Generate a vacancy-specific preparation plan and question set.
4. Run a spoken mock interview.
5. Evaluate answer specificity, examples, evidence, and missing details.
6. Track readiness by topic and keep the candidate's prepared facts accessible.

## Initial users

The initial segment is Russian-speaking junior and middle-level technology candidates, starting with QA, analytics, and software-development roles. The strongest use moment is one to seven days before a scheduled interview.

## Differentiation

- The complete workflow starts from a real vacancy instead of a generic prompt.
- Readiness is organized by skill and topic rather than as an unstructured chat history.
- Spoken practice and answer feedback are integrated into the desktop product.
- Speech recognition uses OpenAI transcription models through a direct or managed gateway path.
- The first market is Russian-speaking candidates and Russian interview conventions.

## Product architecture

- **Electron desktop client:** preparation workspace and optional compact notes overlay.
- **Local FastAPI engine:** session orchestration, documents, local data, and speech integration.
- **Cloud speech recognition:** sends completed speech fragments to OpenAI directly or through the SkillCue gateway for transcription.
- **Managed text inference path:** sends the text required for vacancy analysis and answer feedback to a configured language-model provider.
- **Licensing and billing:** controls paid access without publishing private implementation details.
- **Release channel:** distributes Windows installers and update metadata.

## Privacy model

Completed speech fragments are sent to OpenAI directly or through the SkillCue gateway for transcription. Resumes, vacancies, and preparation history are stored locally by default. The public privacy notice explains these boundaries and the use of website analytics and payment processors.

## Responsible AI

SkillCue helps candidates prepare and articulate their real experience. It does not endorse fabricated qualifications, identity substitution, or violation of employer interview rules. Users are instructed to verify model output, answer in their own words, and use supplementary material only where the interview format permits it.

## Validation milestones

### First 10 testers

- Confirm installation and onboarding on real Windows devices.
- Measure completed vacancy analyses and mock interviews.
- Collect structured feedback about question relevance and answer feedback.
- Record failures without collecting raw interview audio.

### 50 monthly active testers

- Measure preparation-session completion and repeat use.
- Establish inference latency and cost per completed session.
- Compare model configurations against a fixed Russian-language evaluation set.
- Prioritize the most common roles and failure patterns.

### 100 monthly active testers

- Add production budget alerts, rate limits, and service monitoring.
- Measure retention and the percentage of users who complete more than one preparation session.
- Evaluate an English-language experiment only after the Russian workflow is stable.

## Six-month roadmap

1. Recruit the first 10 external testers and resolve installation blockers.
2. Instrument opt-in product analytics for completed preparation steps.
3. Build repeatable evaluation sets for vacancy analysis and answer feedback.
4. Introduce a managed, rate-limited text inference gateway.
5. Reach 50 monthly active testers with measured inference cost and latency.

## Twelve-month roadmap

1. Reach 100 monthly active testers and validate repeat preparation use.
2. Improve role-specific evaluation for QA, analytics, and development.
3. Add monitoring, backups, and cost controls for production services.
4. Test an English-language workflow without weakening the Russian product.

## Cloud-credit use

- Language-model inference for vacancy analysis, mock interviews, and answer evaluation.
- Controlled model comparison and Russian-language quality evaluation.
- A secure API gateway with authentication, rate limiting, and budget limits.
- Opt-in analytics, logs, monitoring, alerts, and test environments.
- Non-sensitive release metadata, evaluation assets, and backups.

Credits will not be presented as current spend. They fund validation and production hardening during the next 12 months.

## Main risks and mitigations

| Risk | Mitigation |
| --- | --- |
| No proven user demand yet | Start with 10 external testers and measurable preparation-session completion. |
| AI output can be inaccurate | Require user verification and maintain fixed evaluation cases. |
| Interview assistance can be perceived as deceptive | Lead with preparation, prohibit fabricated experience, and respect interview rules. |
| Windows installation trust | Keep release checks, publish clear provenance, and pursue code signing. |
| Cloud costs can grow before retention is proven | Apply per-user limits, provider budgets, caching where appropriate, and cost-per-session monitoring. |

## Public proof

- Product website: <https://skill-cue.ru/>
- Public Windows releases: <https://github.com/GalievGleb/SkillCue/releases/latest>
- Support: <https://t.me/SkillCue_support_bot>
