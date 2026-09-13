# Alpha DeepSeek screen routing implementation plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task.

**Goal:** Use `deepseek/deepseek-v4.1-flash` through OpenRouter for Alpha screenshot Auto selection.

**Architecture:** Keep the typed screen pipeline and quota checks. Add one exact gateway model route with the same shape and plan restrictions. Preserve Dev/Stable defaults and explicit model selections.

**Tech Stack:** Python/FastAPI, TypeScript/NestJS, Electron.

**Spec:** User request in this task: install DeepSeek V4.1 Flash via OpenRouter in Alpha for manual testing.

## Global constraints

- Do not change voice defaults, Stable or Dev installations, or expose credentials.
- Do not weaken structured request validation or license checks.

### Task 1: Routing and deployment

- [ ] Add route tests: Alpha Auto requests use DeepSeek; explicit selections remain unchanged; other channels retain GPT screen default.
- [ ] Add gateway tests for observation, answer and repair through OpenRouter using the exact DeepSeek id. Preserve rejection tests for other models and unauthorized plans.
- [ ] Run tests before implementation and confirm expected failures.
- [ ] Implement Alpha-only default and bounded low-reasoning options; permit exact DeepSeek structured requests on the configured OpenRouter upstream.
- [ ] Run Python routing/provider and gateway test suites, then build API.
- [ ] Deploy only the changed gateway module with recoverable backup; verify a real paid screenshot pipeline request using existing Alpha identity.
- [ ] Build/install Alpha; verify packaged model routing. User performs subjective quality acceptance.
