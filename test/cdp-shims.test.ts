import { describe, expect, it } from "vitest"
import type { WebSocket } from "ws"
import {
  chromeSessionIdForClientRequest,
  createClientTargetAnnouncements,
  hasAnnouncedSession,
  removeClientTargetAliases,
  replayChildTargetsForParent,
  sendAttachedToChildTarget,
  sendAttachedToTarget,
  type ClientCdpSessionAlias,
} from "../src/cdp-shims.ts"
import type { ChildTarget, ConnectedTarget } from "../src/relay-types.ts"
import type { CdpEvent, TargetInfo } from "../src/protocol.ts"
import { TargetRegistry } from "../src/target-registry.ts"

function socket(events: CdpEvent[]): WebSocket {
  return {
    send: (data: string) => {
      events.push(JSON.parse(data) as CdpEvent)
    },
  } as WebSocket
}

function targetInfo(targetId: string): TargetInfo {
  return { targetId, type: "page", title: "title", url: "https://example.com/", attached: true, canAccessOpener: false }
}

function root(sessionId: string, targetId = "target-1"): ConnectedTarget {
  return { tabId: 1, sessionId, targetInfo: targetInfo(targetId), owner: "user" }
}

function child(sessionId: string, targetId = "child-target-1", parentSessionId = "bc-tab-1"): ChildTarget {
  return { tabId: 1, sessionId, parentSessionId, targetInfo: { ...targetInfo(targetId), type: "iframe" }, waitingForDebugger: false }
}

describe("chromeSessionIdForClientRequest", () => {
  it("does not forward a client alias for a root target to Chrome", () => {
    expect(chromeSessionIdForClientRequest({
      alias: {},
      requestedSessionId: "bc-client-session-1",
      rootSessionId: "bc-tab-1",
    })).toBeUndefined()
  })

  it("forwards the real Chrome session behind a child-target alias", () => {
    expect(chromeSessionIdForClientRequest({
      alias: { chromeSessionId: "chrome-child-1" },
      requestedSessionId: "bc-client-session-2",
      rootSessionId: "bc-tab-1",
    })).toBe("chrome-child-1")
  })
})

describe("removeClientTargetAliases", () => {
  it("removes aliases for a detached tab without touching other tabs", () => {
    const aliases = new Map<string, ClientCdpSessionAlias>([
      ["browser", { kind: "browser" }],
      ["detached-root", { kind: "target", tabId: 7, targetId: "root-7" }],
      ["detached-child", { kind: "target", tabId: 7, targetId: "child-7", chromeSessionId: "chrome-child-7" }],
      ["other-root", { kind: "target", tabId: 8, targetId: "root-8" }],
    ])

    removeClientTargetAliases([aliases], (alias) => alias.tabId === 7)

    expect(Array.from(aliases.keys())).toEqual(["browser", "other-root"])
  })
})

describe("TargetRegistry crash state", () => {
  it("marks a root target crashed and clears the marker after navigation", () => {
    const registry = new TargetRegistry()
    registry.addRootTarget(root("bc-tab-1"))

    expect(registry.markRootTargetCrashed(1)?.crashed).toBe(true)
    expect(registry.getRootTargetByTabId(1)?.crashed).toBe(true)

    registry.updateTargetUrl(1, "https://example.com/recovered")
    expect(registry.getRootTargetByTabId(1)?.crashed).toBe(false)
  })
})

describe("sendAttachedToTarget", () => {
  it("does not re-announce the same target id and session id", () => {
    const events: CdpEvent[] = []
    const client = socket(events)
    const announcements = new Map([[client, createClientTargetAnnouncements()]])

    sendAttachedToTarget({ socket: client, clientAnnouncements: announcements, target: root("bc-tab-1") })
    sendAttachedToTarget({ socket: client, clientAnnouncements: announcements, target: root("bc-tab-1") })

    expect(events).toHaveLength(1)
    expect(events[0]?.method).toBe("Target.attachedToTarget")
    expect(hasAnnouncedSession(announcements.get(client), "bc-tab-1")).toBe(true)
  })

  it("detaches the old session before re-announcing the same target id under a new session id", () => {
    const events: CdpEvent[] = []
    const client = socket(events)
    const announcements = new Map([[client, createClientTargetAnnouncements()]])

    sendAttachedToTarget({ socket: client, clientAnnouncements: announcements, target: root("bc-tab-1") })
    sendAttachedToTarget({ socket: client, clientAnnouncements: announcements, target: root("bc-tab-2") })

    expect(events.map((event) => event.method)).toEqual([
      "Target.attachedToTarget",
      "Target.detachedFromTarget",
      "Target.attachedToTarget",
    ])
    expect(events[1]).toEqual({ method: "Target.detachedFromTarget", params: { sessionId: "bc-tab-1", targetId: "target-1" } })
    expect(hasAnnouncedSession(announcements.get(client), "bc-tab-1")).toBe(false)
    expect(hasAnnouncedSession(announcements.get(client), "bc-tab-2")).toBe(true)
  })
})

describe("sendAttachedToChildTarget", () => {
  it("detaches duplicate child target ids on the parent session before re-announcing", () => {
    const events: CdpEvent[] = []
    const client = socket(events)
    const announcements = new Map([[client, createClientTargetAnnouncements()]])

    sendAttachedToChildTarget({ socket: client, clientAnnouncements: announcements, target: child("child-session-1") })
    sendAttachedToChildTarget({ socket: client, clientAnnouncements: announcements, target: child("child-session-2") })

    expect(events.map((event) => event.method)).toEqual([
      "Target.attachedToTarget",
      "Target.detachedFromTarget",
      "Target.attachedToTarget",
    ])
    expect(events[1]).toEqual({
      sessionId: "bc-tab-1",
      method: "Target.detachedFromTarget",
      params: { sessionId: "child-session-1", targetId: "child-target-1" },
    })
  })

  it("replays dedicated workers without synthesizing iframe navigation events", () => {
    const events: CdpEvent[] = []
    const client = socket(events)
    const announcements = new Map([[client, createClientTargetAnnouncements()]])
    const registry = new TargetRegistry()
    registry.addChildTarget({
      ...child("worker-session", "worker-target"),
      targetInfo: { ...targetInfo("worker-target"), type: "worker", url: "https://example.com/worker.js" },
      waitingForDebugger: true,
    })

    replayChildTargetsForParent({
      socket: client,
      parentSessionId: "bc-tab-1",
      registry,
      clientAnnouncements: announcements,
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      sessionId: "bc-tab-1",
      method: "Target.attachedToTarget",
      params: { sessionId: "worker-session", waitingForDebugger: true, targetInfo: { type: "worker" } },
    })
  })

  it("does not replay a held URL-less page child", () => {
    const events: CdpEvent[] = []
    const client = socket(events)
    const registry = new TargetRegistry()
    registry.addChildTarget({
      ...child("held-session", "held-target"),
      targetInfo: { ...targetInfo("held-target"), type: "page", url: "" },
    })

    replayChildTargetsForParent({
      socket: client,
      parentSessionId: "bc-tab-1",
      registry,
      clientAnnouncements: new Map([[client, createClientTargetAnnouncements()]]),
    })

    expect(events).toEqual([])
  })
})
