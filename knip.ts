import type { KnipConfig } from "knip"

export default {
  // Trailing ! keeps runtime roots in the optional --production audit.
  entry: [
    // The SDK entry exposes public namespaces; do not enable includeEntryExports.
    "src/index.ts!",
    "src/cli.ts!",
    "src/mcp-main.ts!",
    // Browser-loaded roots from manifest.json, offscreen.html, and build-extension.ts.
    "extension/src/background.ts!",
    "extension/src/content-script.ts!",
    "extension/src/offscreen.ts!",
    // Executed as sandbox programs, not imported by the Node entrypoints.
    "scripts/opencode-jr-developer-onboarding.js",
    "scripts/opencode-jr-signup-handoff.js",
    "scripts/wikipedia-cursor-demo.js",
  ],
  project: ["src/**/*.ts!", "extension/src/**/*.ts!", "scripts/*.{ts,js}", "test/**/*.ts"],
  // Package scripts discover the TS command entrypoints; Vitest discovers tests.
  vitest: { entry: ["test/**/*.test.ts"] },
  // Align the transitive Node runtime with Effect's prerelease scope layout.
  ignoreDependencies: ["@effect/platform-node-shared"],
  // ffmpeg is installed separately; the benchmark invokes this package's own bin.
  ignoreBinaries: ["ffmpeg", "browser-control"],
} satisfies KnipConfig
