import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { unzipSync } from "fflate"
import { extensionVersion, isChromeExtensionVersion, makeExtensionArchive } from "../scripts/package-extension.ts"

describe("Chrome Web Store extension package", () => {
  it("is deterministic and rooted at the extension manifest", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-extension-package-"))
    try {
      await fs.mkdir(path.join(directory, "icons"))
      await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ manifest_version: 3, version: "1.2.3.4" }))
      await fs.writeFile(path.join(directory, "background.js"), "export {}\n")
      await fs.writeFile(path.join(directory, "icons", "icon-16.png"), new Uint8Array([1, 2, 3]))

      const first = await makeExtensionArchive(directory)
      await fs.utimes(path.join(directory, "background.js"), new Date(), new Date())
      const second = await makeExtensionArchive(directory)

      expect(second).toEqual(first)
      expect(Object.keys(unzipSync(first)).sort()).toEqual([
        "background.js",
        "icons/icon-16.png",
        "manifest.json",
      ])
      expect(await extensionVersion(directory)).toBe("1.2.3.4")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("validates Chrome extension version components", () => {
    expect(isChromeExtensionVersion("0.0.19")).toBe(true)
    expect(isChromeExtensionVersion("65535.1.2.3")).toBe(true)
    expect(isChromeExtensionVersion("1.2.3.4.5")).toBe(false)
    expect(isChromeExtensionVersion("65536")).toBe(false)
    expect(isChromeExtensionVersion("01.2")).toBe(false)
    expect(isChromeExtensionVersion("1.-2")).toBe(false)
  })

  it("rejects source maps", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-extension-package-"))
    try {
      await fs.writeFile(path.join(directory, "background.js.map"), "{}")
      await expect(makeExtensionArchive(directory)).rejects.toThrow("must not contain source maps")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
