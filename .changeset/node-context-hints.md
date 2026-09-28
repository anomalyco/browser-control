---
"@opencode-ai/browser-control": patch
---

Execute code runs in Node. Scripts that read `window`, `document`, or storage, or that call `fetch` with a relative URL, now get a warning that points to `page.evaluate`. `execute --file` errors include the file-system reason, such as a missing file. `pnpm build:extension` builds in a staging directory and then replaces `extension/dist` file by file, so a failed build no longer leaves the unpacked extension directory empty.
