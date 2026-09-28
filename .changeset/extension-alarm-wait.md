---
"@opencode-ai/browser-control": patch
---

Wait long enough for a sleeping extension to reconnect. When the relay is down, Chrome stops the extension's idle MV3 worker, and only the 30-second reconnect alarm wakes it. After starting a relay, the CLI, MCP server, and SDK client waited about 10 seconds, so they often reported "extension is not connected" before the alarm fired. They now wait up to 35 seconds, and the CLI prints one line when the wait begins. The alarm period and the wait both come from one shared constant.
