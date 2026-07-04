import { describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  appendJournalEntry,
  formatJournalEntry,
  journalPathForSession,
  listJournaledSessions,
  makeJournalEntry,
  parseJournalLines,
  readJournalEntries,
  truncateForJournal,
} from "../src/session-journal.ts"

const makeTempBaseDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bc-journal-test-"))

describe("session-journal", () => {
  it("appends and reads entries in order", async () => {
    const baseDir = makeTempBaseDir()
    for (const code of ["first()", "second()", "third()"]) {
      await appendJournalEntry({
        baseDir,
        entry: makeJournalEntry({
          sessionId: "alpha",
          code,
          isError: false,
          durationMs: 5,
          resultText: "ok",
          logCount: 0,
        }),
      })
    }
    const entries = await readJournalEntries({ baseDir, sessionId: "alpha", limit: 2 })
    expect(entries.map((entry) => entry.code)).toEqual(["second()", "third()"])
    expect(await listJournaledSessions(baseDir)).toEqual(["alpha"])
  })

  it("returns empty for missing journals", async () => {
    const baseDir = makeTempBaseDir()
    expect(await readJournalEntries({ baseDir, sessionId: "ghost", limit: 10 })).toEqual([])
    expect(await listJournaledSessions(path.join(baseDir, "missing"))).toEqual([])
  })

  it("skips corrupt and non-matching lines", () => {
    const good = JSON.stringify(makeJournalEntry({
      sessionId: "alpha",
      code: "x",
      isError: false,
      durationMs: 1,
      resultText: "ok",
      logCount: 0,
    }))
    const entries = parseJournalLines(`not json\n{"unrelated":true}\n${good}\n`)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.sessionId).toBe("alpha")
  })

  it("records aftermath fields only when present", () => {
    const bare = makeJournalEntry({
      sessionId: "alpha",
      code: "x",
      isError: false,
      durationMs: 1,
      resultText: "ok",
      logCount: 0,
    })
    expect("navigations" in bare).toBe(false)
    expect("handoffs" in bare).toBe(false)
    const full = makeJournalEntry({
      sessionId: "alpha",
      code: "x",
      isError: true,
      durationMs: 1,
      resultText: "boom",
      logCount: 2,
      startUrl: "https://a.test/",
      endUrl: "https://b.test/",
      navigations: ["https://b.test/"],
      warnings: ["page recreated"],
      diagnostic: "execution-context/context-destroyed; pageClosed=false; urlChanged=true; mainFrameNavigations=1",
      handoffs: 1,
    })
    expect(full.navigations).toEqual(["https://b.test/"])
    expect(full.handoffs).toBe(1)
    expect(full.warnings).toEqual(["page recreated"])
    expect(full.diagnostic).toContain("context-destroyed")
  })

  it("truncates long code and result previews", () => {
    const long = "a".repeat(3_000)
    const entry = makeJournalEntry({
      sessionId: "alpha",
      code: long,
      isError: false,
      durationMs: 1,
      resultText: long,
      logCount: 0,
      diagnostic: long,
    })
    expect(entry.code.length).toBeLessThan(2_100)
    expect(entry.code).toContain("[truncated")
    expect(entry.resultPreview.length).toBeLessThan(500)
    expect(entry.diagnostic?.length).toBeLessThan(300)
    expect(truncateForJournal("short", 100)).toBe("short")
  })

  it("formats a readable line", () => {
    const entry = makeJournalEntry({
      sessionId: "alpha",
      code: "await page.goto('https://example.com')",
      isError: false,
      durationMs: 1234,
      resultText: "ok",
      logCount: 0,
      startUrl: "about:blank",
      endUrl: "https://example.com/",
      navigations: ["https://example.com/"],
      handoffs: 1,
      diagnostic: "execution-context/context-missing; pageClosed=false; urlChanged=false; mainFrameNavigations=0",
    })
    const line = formatJournalEntry(entry)
    expect(line).toContain("ok")
    expect(line).toContain("1234ms")
    expect(line).toContain("https://example.com/")
    expect(line).toContain("handoffs=1")
    expect(line).toContain("diagnostic=execution-context/context-missing")
    expect(line).toContain("await page.goto")
  })

  it("journalPathForSession nests under the session id", () => {
    expect(journalPathForSession("/base", "alpha")).toBe(path.join("/base", "alpha", "journal.jsonl"))
  })
})
