# Google for Startups Cloud Program — SkillCue

Official program: <https://startup.google.com/cloud/>

## Target program

Google for Startups Cloud Program, Start tier. SkillCue is early-stage, self-funded, and has not received equity funding.

## Short startup description

SkillCue is a working pre-launch Windows application that converts a real job vacancy into a personalized preparation plan, skill-gap map, and spoken mock interview for Russian-speaking candidates. It combines OpenAI speech transcription with cloud text inference for analysis and feedback.

## User problem

Candidates preparing under time pressure must currently combine vacancy analysis, generic question lists, AI chats, notes, and mock interviews manually. The result is inconsistent and does not show which role-specific topics remain weak.

## Product solution

SkillCue extracts skills and likely questions from a vacancy, generates a structured preparation path, conducts mock interviews, evaluates concrete evidence in answers, and tracks readiness by topic.

## Current stage and traction

The Windows MVP is working and ready for external testing. SkillCue currently has no external users, revenue, investment, or accelerator backing. The first validation milestone is 10 testers and structured feedback.

## Planned Google Cloud use

- Vertex AI for controlled model evaluation, vacancy analysis, and answer feedback.
- Cloud Run for a minimal authenticated text inference gateway.
- Cloud Storage for non-sensitive release metadata and evaluation assets.
- Cloud Logging and Cloud Monitoring for latency, errors, usage, and budget alerts.
- BigQuery only after opt-in analytics volume justifies it; it is not required for the first 10 testers.

Completed speech fragments are sent to OpenAI directly or through the SkillCue gateway for transcription. Vacancy and answer text is sent to the selected model endpoint only for the requested analysis.

## Validation plan

1. Recruit 10 external testers and measure successful installation and completed preparation sessions.
2. Reach 50 monthly active testers while measuring inference quality, latency, unit cost, and repeat use.
3. Reach 100 monthly active testers with production alerts, per-user limits, and a stable evaluation set.

## Credit-use discipline

SkillCue will start with budget alerts, rate limits, separate test and production environments, and a cost-per-completed-session metric. Credits are requested for future validation and hardening; they are not presented as reimbursement for existing spend.

## Responsible AI

The product is positioned as an interview-preparation tool. It helps candidates explain their real experience, requires verification of AI output, and discourages fabricated qualifications, identity substitution, or violation of interview rules.

## Why Google Cloud

Vertex AI and Cloud Run provide a compact path for model evaluation and controlled deployment. The Start tier matches SkillCue's current unfunded pre-launch stage and allows the founder to validate product quality before making a larger infrastructure commitment.
