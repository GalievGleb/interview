# AWS Activate Founders Application — SkillCue

Official program: <https://aws.amazon.com/startups/credits/>

## Target tier

AWS Activate Founders for a self-funded, pre-seed software product. SkillCue is not backed by an accelerator, investor, or venture fund and should not claim an Activate Provider organization ID.

## Short company description

SkillCue is a working pre-launch Windows application that turns a specific vacancy into a personalized interview preparation plan, skill-gap map, and spoken mock interview for Russian-speaking job seekers. OpenAI transcription models provide speech recognition, while a managed text inference path provides vacancy analysis and answer feedback.

## Problem and solution

Generic interview-question lists and general-purpose AI chats do not give candidates a repeatable way to prepare for the exact role they are pursuing. SkillCue extracts role-specific topics, identifies weak areas, runs mock interviews, evaluates answer quality, and tracks readiness in one workflow.

## Current traction

The application is a working pre-launch MVP with no external users or revenue. The next milestone is 10 external testers, followed by 50 and 100 monthly active testers. This application does not claim customers, funding, partnerships, or prior cloud grants.

## Planned AWS use

- Amazon Bedrock experiments for vacancy analysis, mock-interview prompts, and answer evaluation.
- API Gateway for an authenticated and rate-limited managed text path.
- AWS Lambda or a small container service for lightweight request orchestration.
- Amazon S3 for non-sensitive release metadata and evaluation assets.
- Amazon CloudWatch for availability, latency, error, usage, and budget monitoring.

Completed speech fragments are uploaded to OpenAI directly or through the SkillCue gateway for transcription. Speech recognition in the current release is cloud-based.

## Twelve-month success metrics

| Milestone | Evidence |
| --- | --- |
| 10 external testers | Successful installs, completed preparation sessions, structured feedback. |
| 50 monthly active testers | Measured completion, latency, inference cost per session, and repeat use. |
| 100 monthly active testers | Production alerts, per-user limits, stable evaluation set, and retention measurement. |

## Expected resource categories

The requested credits are intended for model inference, a low-volume API gateway, monitoring, non-sensitive object storage, and test environments. SkillCue has no historical AWS spend to report. Budgets and alerts will be configured before public growth experiments.

## Responsible use

SkillCue helps candidates prepare and explain their real experience. It instructs users to verify AI output, avoid fabricated qualifications, and comply with employer interview rules.

## Why AWS

AWS provides a path from model experimentation in Bedrock to a rate-limited production gateway, monitoring, storage, and cost controls within one platform. This supports SkillCue's immediate need: validate quality and unit cost before scaling.
