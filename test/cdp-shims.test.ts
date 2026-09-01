import { describe, expect, it } from "vitest"
import type { WebSocket } from "ws"
import { CdpClientPool } from "../src/cdp-client-pool.ts"
import { replayChildTargetsForParent } from "../src/cdp-shims.ts"
import type { ChildTarget, ConnectedTarget } from "../src/relay-types.ts"
import { parseJsonObject, type JsonObject, type TargetInfo } from "../src/protocol.ts"
import { sendCdpEvent } from "../src/relay-helpers.ts"
import { TargetRegistry } from "../src/target-registry.ts"

function setup() {
  const events: JsonObject[] = []
  const socket: Pick<WebSocket, "send"> = {
    send(data) {
      if (typeof data !== "string") throw new Error("Expected a serialized CDP event")
      events.push(parseJsonObject(data))
    },
  }
  const clients = new CdpClientPool<typeof socket>(sendCdpEvent)
  clients.register(socket)
  return { socket, clients, events, registry: new TargetRegistry() }
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

describe("replayChildTargetsForParent", () => {
  it("replays dedicated workers without synthesizing iframe navigation events", () => {
    const { socket, clients, events, registry } = setup()
    registry.addChildTarget({
      ...child("worker-session", "worker-target"),
      targetInfo: { ...targetInfo("worker-target"), type: "worker", url: "https://example.com/worker.js" },
      waitingForDebugger: true,
    })

    replayChildTargetsForParent({
      socket,
      parentSessionId: "bc-tab-1",
      registry,
      clients,
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      sessionId: "bc-tab-1",
      method: "Target.attachedToTarget",
      params: { sessionId: "worker-session", waitingForDebugger: true, targetInfo: { type: "worker" } },
    })
  })

  it("does not replay a held URL-less page child", () => {
    const { socket, clients, events, registry } = setup()
    registry.addChildTarget({
      ...child("held-session", "held-target"),
      targetInfo: { ...targetInfo("held-target"), type: "page", url: "" },
    })

    replayChildTargetsForParent({
      socket,
      parentSessionId: "bc-tab-1",
      registry,
      clients,
    })

    expect(events).toEqual([])
    expect(clients.hasSession(socket, "held-session")).toBe(false)
  })

  it("replays iframe parent events before attachment and navigation on the child session", () => {
    const { socket, clients, events, registry } = setup()
    const target = child("iframe-session")
    registry.addChildTarget(target)
    registry.addChildTarget(child("unrelated-session", "unrelated-target", "other-parent"))
    const attached = { frameId: target.targetInfo.targetId, parentFrameId: "root-frame" }
    const navigated = { frame: { id: target.targetInfo.targetId, parentId: "root-frame", url: "https://example.com/stale" } }
    registry.rememberFrameEvent({ tabId: 1, frameId: target.targetInfo.targetId, attached, navigated })

    replayChildTargetsForParent({ socket, parentSessionId: "bc-tab-1", registry, clients })

    expect(events).toEqual([
      { sessionId: "bc-tab-1", method: "Page.frameAttached", params: attached },
      { sessionId: "bc-tab-1", method: "Page.frameNavigated", params: navigated },
      {
        sessionId: "bc-tab-1",
        method: "Target.attachedToTarget",
        params: { sessionId: target.sessionId, targetInfo: target.targetInfo, waitingForDebugger: false },
      },
      {
        sessionId: target.sessionId,
        method: "Page.frameNavigated",
        params: { frame: { ...navigated.frame, url: target.targetInfo.url } },
      },
    ])
    expect(clients.hasSession(socket, target.sessionId)).toBe(true)
    expect(clients.hasSession(socket, "unrelated-session")).toBe(false)
  })

  it("synthesizes child iframe navigation from target info when no frame event was retained", () => {
    const { socket, clients, events, registry } = setup()
    const target = child("iframe-session")
    registry.addChildTarget(target)

    replayChildTargetsForParent({ socket, parentSessionId: "bc-tab-1", registry, clients })

    expect(events.map((event) => event.method)).toEqual(["Target.attachedToTarget", "Page.frameNavigated"])
    expect(events[1]).toMatchObject({
      sessionId: target.sessionId,
      params: { frame: { id: target.targetInfo.targetId, url: target.targetInfo.url, securityOrigin: "https://example.com" } },
    })
  })
})
