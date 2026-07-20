import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { defaultSessionCatalogPath, SessionCatalog, type PersistedSession } from "../src/session-catalog.ts"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("SessionCatalog", () => {
  it("round-trips endpoint-scoped session descriptors with private permissions", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-session-catalog-"))
    temporaryDirectories.push(home)
    const filePath = defaultSessionCatalogPath(20001, home)
    const catalog = new SessionCatalog(filePath)
    const sessions: PersistedSession[] = [{
      id: "alpha",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:01:00.000Z",
      readOnly: true,
      target: { id: "target-1", owner: "relay" },
    }]

    await catalog.save(sessions)

    await expect(catalog.load()).resolves.toEqual(sessions)
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it("reports invalid data without overwriting it", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-session-catalog-"))
    temporaryDirectories.push(home)
    const filePath = defaultSessionCatalogPath(20002, home)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, "not json")
    const catalog = new SessionCatalog(filePath)

    await expect(catalog.load()).rejects.toThrow("Could not decode Browser Control session catalog")
    expect(fs.readFileSync(filePath, "utf8")).toBe("not json")
  })

  it("rejects session ids that the HTTP API cannot address", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-session-catalog-"))
    temporaryDirectories.push(home)
    const filePath = defaultSessionCatalogPath(20003, home)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      sessions: [{ id: "../escape", createdAt: "now", updatedAt: "now", readOnly: false }],
    }))

    await expect(new SessionCatalog(filePath).load()).rejects.toThrow("Invalid persisted session id")
  })
})
