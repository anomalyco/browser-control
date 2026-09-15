import { expect, it, vi } from "vitest"
import { getOwnedDebuggerTabIds } from "../extension/src/debugger-ownership.ts"

it("excludes DevTools and foreign debugger targets from reconnect and grouping inventory", async () => {
  const sendCommand = vi.fn(async ({ tabId }: chrome.debugger.DebuggerSession) => {
    if (tabId === 2) throw new Error("Debugger is not attached to the tab with id: 2")
    return { targetInfo: { targetId: "owned" } }
  })
  const ids = await getOwnedDebuggerTabIds({
    getTargets: async (): Promise<chrome.debugger.TargetInfo[]> => [
      { id: "owned", tabId: 1, type: "page", title: "Owned", url: "https://example.com", attached: true },
      { id: "devtools", tabId: 2, type: "page", title: "Foreign", url: "https://example.org", attached: true },
      { id: "free", tabId: 3, type: "page", title: "Free", url: "about:blank", attached: false },
    ],
    sendCommand,
  })
  expect([...ids]).toEqual([1])
  expect(sendCommand).not.toHaveBeenCalledWith({ tabId: 3 }, expect.anything())
})

it("preserves unexpected probe failures rather than silently losing owned tabs", async () => {
  const failure = new Error("Transient debugger transport failure")
  await expect(getOwnedDebuggerTabIds({
    getTargets: async (): Promise<chrome.debugger.TargetInfo[]> => [
      { id: "owned", tabId: 1, type: "page", title: "Owned", url: "about:blank", attached: true },
    ],
    sendCommand: async () => { throw failure },
  })).rejects.toBe(failure)
})
