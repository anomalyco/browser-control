declare global {
  // Injected by scripts/build-cli.ts at build time.
  var __BROWSER_CONTROL_VERSION__: string | undefined
  var __BROWSER_CONTROL_BUILD_ID__: string | undefined
}

export const browserControlVersion: string = globalThis.__BROWSER_CONTROL_VERSION__ ?? "0.0.0-dev"
export const browserControlBuildId: string = globalThis.__BROWSER_CONTROL_BUILD_ID__ ?? "dev"
