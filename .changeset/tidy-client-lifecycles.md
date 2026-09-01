---
"@opencode-ai/browser-control": patch
---

Keep CDP attachment and alias cleanup consistent across target replacement,
detachment, and ownership changes. Ignore target updates from retired session
sandboxes so reset or recreated sessions retain their own persisted identity.
