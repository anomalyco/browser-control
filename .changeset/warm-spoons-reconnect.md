---
"@opencode-ai/browser-control": patch
---

Keep the Chrome extension connected across idle service-worker suspension, repair missing reconnect alarms whenever the worker starts, start the managed relay correctly when MCP runs through a package-manager bin symlink, and make Doctor compare the runtime extension with the manifest shipped in the npm package.
