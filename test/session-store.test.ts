import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as SessionStore from "../src/session-store.ts"

const fsLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-control-test-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const runStore = <A>(
  options: { readonly endpoint: string },
  use: (store: SessionStore.Interface) => Effect.Effect<A, SessionStore.SessionStoreError>,
): Promise<A> =>
  Effect.runPromise(
    SessionStore.make({ filePath: path.join(dir, "session.json"), endpoint: options.endpoint }).pipe(
      Effect.flatMap(use),
      Effect.provide(fsLayer),
    ),
  )

const defaultEndpoint = "http://127.0.0.1:19989"
const otherEndpoint = "http://127.0.0.1:29989"

describe("SessionStore", () => {
  it("returns undefined when no file exists", async () => {
    const current = await runStore({ endpoint: defaultEndpoint }, (store) => store.read)
    expect(current).toBeUndefined()
  })

  it("round-trips a session id", async () => {
    const current = await runStore({ endpoint: defaultEndpoint }, (store) =>
      store.write("rapid-otter-633").pipe(Effect.andThen(store.read)))
    expect(current).toBe("rapid-otter-633")
  })

  it("scopes session ids by endpoint", async () => {
    await runStore({ endpoint: defaultEndpoint }, (store) => store.write("default-session"))
    const other = await runStore({ endpoint: otherEndpoint }, (store) => store.read)
    expect(other).toBeUndefined()
    await runStore({ endpoint: otherEndpoint }, (store) => store.write("other-session"))
    const defaultCurrent = await runStore({ endpoint: defaultEndpoint }, (store) => store.read)
    expect(defaultCurrent).toBe("default-session")
  })

  it("clear removes only this endpoint's entry", async () => {
    await runStore({ endpoint: defaultEndpoint }, (store) => store.write("default-session"))
    await runStore({ endpoint: otherEndpoint }, (store) => store.write("other-session"))
    await runStore({ endpoint: defaultEndpoint }, (store) => store.clear)
    expect(await runStore({ endpoint: defaultEndpoint }, (store) => store.read)).toBeUndefined()
    expect(await runStore({ endpoint: otherEndpoint }, (store) => store.read)).toBe("other-session")
  })

  it("reads a legacy { id } file as the default endpoint's session", async () => {
    await fs.writeFile(path.join(dir, "session.json"), `${JSON.stringify({ id: "legacy-session" })}\n`)
    expect(await runStore({ endpoint: defaultEndpoint }, (store) => store.read)).toBe("legacy-session")
    expect(await runStore({ endpoint: otherEndpoint }, (store) => store.read)).toBeUndefined()
  })

  it("migrates a legacy file to the endpoint format on write", async () => {
    await fs.writeFile(path.join(dir, "session.json"), `${JSON.stringify({ id: "legacy-session" })}\n`)
    await runStore({ endpoint: otherEndpoint }, (store) => store.write("other-session"))
    const text = await fs.readFile(path.join(dir, "session.json"), "utf8")
    const parsed = JSON.parse(text) as { readonly endpoints: Record<string, { readonly id: string }> }
    expect(parsed.endpoints[defaultEndpoint]?.id).toBe("legacy-session")
    expect(parsed.endpoints[otherEndpoint]?.id).toBe("other-session")
  })

  it("reports corrupt files instead of overwriting them as empty", async () => {
    await fs.writeFile(path.join(dir, "session.json"), "not json")
    await expect(runStore({ endpoint: defaultEndpoint }, (store) => store.read)).rejects.toMatchObject({
      _tag: "SessionStore.SessionStoreError",
      operation: "decode",
    })
    expect(await fs.readFile(path.join(dir, "session.json"), "utf8")).toBe("not json")
  })
})
