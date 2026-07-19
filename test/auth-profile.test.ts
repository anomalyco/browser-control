import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import * as AuthProfile from "../src/auth-profile.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("AuthProfile", () => {
  it("writes restrictive profiles and returns metadata without values", async () => {
    const baseDir = await temporaryDirectory()
    const result = await Effect.runPromise(AuthProfile.write({
      name: "uber",
      baseDir,
      slots: [{ ref: "BC_SECRET_1", value: "token-value", sources: ["request.header.authorization"] }],
    }))

    expect(result).toMatchObject({ name: "uber", slotCount: 1, slots: [{ ref: "BC_SECRET_1", expired: false }] })
    expect(JSON.stringify(result)).not.toContain("token-value")
    const stat = await fs.stat(path.join(baseDir, "uber.json"))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it("injects profile values and redacts them from child output", async () => {
    const baseDir = await temporaryDirectory()
    await Effect.runPromise(AuthProfile.write({
      name: "uber",
      baseDir,
      slots: [{ ref: "BC_SECRET_1", value: "token-value", sources: ["request.header.authorization"] }],
    }))

    const result = await Effect.runPromise(AuthProfile.run({
      name: "uber",
      baseDir,
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.BC_SECRET_1 || '')"],
    }))
    expect(result).toMatchObject({ exitCode: 0, stdout: "${BC_SECRET_1}", stderr: "" })
  })

  it("does not leak a credential cut by the output budget", async () => {
    const baseDir = await temporaryDirectory()
    await Effect.runPromise(AuthProfile.write({
      name: "uber",
      baseDir,
      slots: [{ ref: "BC_SECRET_1", value: "long-token-value", sources: ["request.header.authorization"] }],
    }))

    const result = await Effect.runPromise(AuthProfile.run({
      name: "uber",
      baseDir,
      maxOutputBytes: 8,
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.BC_SECRET_1 || '')"],
    }))
    expect(result.stdout).toBe("")
    expect(result.stdoutTruncated).toBe(true)
  })

  it("updates an existing profile without changing its creation time", async () => {
    const baseDir = await temporaryDirectory()
    await Effect.runPromise(AuthProfile.write({
      name: "uber",
      baseDir,
      slots: [{ ref: "BC_SECRET_1", value: "old", sources: ["request.header.authorization"] }],
    }))
    const before = await Effect.runPromise(AuthProfile.read("uber", { baseDir }))
    await Effect.runPromise(AuthProfile.write({
      name: "uber",
      baseDir,
      slots: [{ ref: "BC_SECRET_1", value: "new", sources: ["request.header.authorization"] }],
    }))
    const after = await Effect.runPromise(AuthProfile.read("uber", { baseDir }))

    expect(after.createdAt).toBe(before.createdAt)
    expect(after.slots[0]?.value).toBe("new")
  })

  it("does not overwrite a malformed existing profile", async () => {
    const baseDir = await temporaryDirectory()
    const filePath = path.join(baseDir, "uber.json")
    await fs.writeFile(filePath, "not-json", { mode: 0o600 })

    await expect(Effect.runPromise(AuthProfile.write({
      name: "uber",
      baseDir,
      slots: [{ ref: "BC_SECRET_1", value: "new", sources: ["request.header.authorization"] }],
    }))).rejects.toMatchObject({ _tag: "AuthProfile.Error", reason: "invalid-json" })
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("not-json")
  })

  it("terminates a timed-out credential-bearing process", async () => {
    const baseDir = await temporaryDirectory()
    await Effect.runPromise(AuthProfile.write({
      name: "uber",
      baseDir,
      slots: [{ ref: "BC_SECRET_1", value: "token-value", sources: ["request.header.authorization"] }],
    }))

    const result = await Effect.runPromise(AuthProfile.run({
      name: "uber",
      baseDir,
      timeoutMs: 20,
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    }))
    expect(result.exitCode).toBe(1)
    expect(result.signal).toMatch(/SIGTERM|SIGKILL/)
  })

  it("does not pass inherited Browser Control secret slots to the child", async () => {
    const baseDir = await temporaryDirectory()
    await Effect.runPromise(AuthProfile.write({
      name: "uber",
      baseDir,
      slots: [{ ref: "BC_SECRET_1", value: "profile-token", sources: ["request.header.authorization"] }],
    }))
    process.env.BC_SECRET_999 = "inherited-token"
    try {
      const result = await Effect.runPromise(AuthProfile.run({
        name: "uber",
        baseDir,
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.env.BC_SECRET_999 || '')"],
      }))
      expect(result.stdout).toBe("")
    } finally {
      delete process.env.BC_SECRET_999
    }
  })

  it("serializes profile transactions through a filesystem lock", async () => {
    const baseDir = await temporaryDirectory()
    let active = 0
    let maximumActive = 0
    const transaction = () => AuthProfile.withLock("uber", { baseDir }, Effect.gen(function* () {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      yield* Effect.sleep(30)
      active -= 1
    }))

    await Promise.all([Effect.runPromise(transaction()), Effect.runPromise(transaction())])
    expect(maximumActive).toBe(1)
    await expect(fs.stat(path.join(baseDir, "uber.json.lock"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-auth-"))
  temporaryDirectories.push(directory)
  return directory
}
