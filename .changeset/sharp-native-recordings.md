---
"@opencode-ai/browser-control": patch
---

Fix undersized, padded CDP recordings with emulated viewports and Retina backing
surfaces. Preserve the starting viewport instead of downscaling to 720p, improve
source image quality, and default to 60 fps with a 60 fps ceiling. Frame delivery
still depends on the browser; use a lower frame rate for smaller recordings.
