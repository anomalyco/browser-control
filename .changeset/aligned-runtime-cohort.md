---
"@opencode-ai/browser-control": patch
---

Pin the shared Node platform to the same Effect prerelease as the CLI runtime,
preventing incompatible scope layouts in fresh standalone installations. Validate
the packed dependency cohort, CLI, and SDK in an isolated pnpm consumer before
accepting a runtime candidate or publishing through the release workflow.
