## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Mandatory installed Dev smoke

After every Dev build/install that can affect the backend, provider routing,
overlay, prompts, licensing, packaging, or updates, do not report success based
only on unit tests, typechecks, `/health`, or a direct provider request.

The final required gate is:

```powershell
pnpm --filter @interview/desktop verify:dev:overlay
```

It must run after `dist:dev` and after installing `SkillCue-Dev-Setup.exe`. The
gate starts the backend from the installed application without opening
Electron, sends the exact `/chat/interview/stream` SSE payload used by the
overlay, asks a real QA question, requires a first chunk and `done` event, and
validates the spoken answer. A failed or skipped gate means the installed Dev
build is not verified and must not be described as ready for an interview.

## Dev verification must not leak into the customer build

- The installed-overlay smoke test, diagnostic fixtures, synthetic questions,
  debug endpoints, and developer reports are development/CI tooling only.
- Keep this tooling under `tools/`, tests, or CI. Do not add a customer-facing
  "test overlay" button, debug screen, test recordings, or diagnostic controls
  to the stable application unless the product owner explicitly asks for it.
- Do not package development verification scripts or their generated data in
  stable installers. Stable users receive only normal product functionality.
- Unit and regression tests stay in the repository and run before release, but
  they are not runtime product features and must not be copied into the UI.
- A public release tag must point to a stable desktop version without a `-dev`
  suffix. After publishing, local Dev builds may return to the `-dev` version.
