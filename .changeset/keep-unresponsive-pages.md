---
"@opencode-ai/browser-control": patch
---

Keep a relay-owned session page whose execution context stops answering automation instead of closing it and replacing it with `about:blank`. Only crashed, `about:blank`, or `chrome-error://` relay-owned pages are recreated; any other live page is re-resolved over a fresh relay connection once and then reported with a `session-page/*-unresponsive` diagnosis that names the kept tab. A resolved handoff whose destination context never appears now explains that the user finished and only Browser Control's view is stale. `session adopt --session <id>` creates the named session when it does not exist, and an ambiguous `--target-url` lists the matching pages.
