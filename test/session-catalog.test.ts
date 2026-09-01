import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defaultSessionCatalogPath, SessionCatalog, type PersistedSession } from "../src/session-catalog.ts"

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
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

  it.each([
    "temporary-open",
    "write",
    "file-sync",
    "rename",
    "directory-open",
    "directory-sync",
  ])("reports %s failures without corrupting the catalog or leaving temporary files", async (step) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-session-catalog-"))
    temporaryDirectories.push(home)
    const filePath = defaultSessionCatalogPath(20001, home)
    const directory = path.dirname(filePath)
    const catalog = new SessionCatalog(filePath)
    const previous: PersistedSession[] = [{ id: "alpha", createdAt: "now", updatedAt: "now", readOnly: false }]
    const next: PersistedSession[] = [{ id: "beta", createdAt: "now", updatedAt: "now", readOnly: true }]
    await catalog.save(previous)
    const previousContents = fs.readFileSync(filePath, "utf8")
    const failure = new Error(`Injected ${step} failure`)
    const open = fsPromises.open.bind(fsPromises)
    const handles: fsPromises.FileHandle[] = []
    vi.spyOn(fsPromises, "open").mockImplementation(async (file, flags, mode) => {
      const isDirectory = file === directory
      if ((step === "directory-open" && isDirectory) || (step === "temporary-open" && !isDirectory)) throw failure
      const handle = await open(file, flags, mode)
      handles.push(handle)
      vi.spyOn(handle, "close")
      if (step === "write" && !isDirectory) {
        const writeFile = handle.writeFile.bind(handle)
        vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
          await writeFile("partial invalid json", "utf8")
          throw failure
        })
      }
      if ((step === "file-sync" && !isDirectory) || (step === "directory-sync" && isDirectory)) {
        vi.spyOn(handle, "sync").mockRejectedValueOnce(failure)
      }
      return handle
    })
    if (step === "rename") vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(failure)

    await expect(catalog.save(next)).rejects.toMatchObject({
      message: `Could not write Browser Control session catalog at ${filePath}`,
      cause: failure,
    })

    // A readable replacement is not proof of durability when the directory sync fails.
    const renamed = step === "directory-open" || step === "directory-sync"
    await expect(catalog.load()).resolves.toEqual(renamed ? next : previous)
    if (!renamed) expect(fs.readFileSync(filePath, "utf8")).toBe(previousContents)
    expect(fs.readdirSync(directory)).toEqual(["sessions.json"])
    for (const handle of handles) expect(handle.close).toHaveBeenCalledOnce()

    vi.restoreAllMocks()
    await catalog.save(next)
    await expect(catalog.load()).resolves.toEqual(next)
  })

  it("still removes the temporary file if closing it fails during cleanup", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-control-session-catalog-"))
    temporaryDirectories.push(home)
    const filePath = defaultSessionCatalogPath(20001, home)
    const catalog = new SessionCatalog(filePath)
    await catalog.save([])
    const previousContents = fs.readFileSync(filePath, "utf8")
    const failure = new Error("Injected file sync failure")
    const open = fsPromises.open.bind(fsPromises)
    vi.spyOn(fsPromises, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode)
      vi.spyOn(handle, "sync").mockRejectedValueOnce(failure)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, "close").mockImplementationOnce(async () => {
        await close()
        throw new Error("Injected cleanup close failure")
      })
      return handle
    })

    await expect(catalog.save([])).rejects.toMatchObject({ cause: failure })
    expect(fs.readFileSync(filePath, "utf8")).toBe(previousContents)
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(["sessions.json"])
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
