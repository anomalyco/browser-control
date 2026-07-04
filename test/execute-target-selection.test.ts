import { describe, expect, it } from "vitest"
import { selectAdoptCandidateByUrl, selectTarget, shouldCloseCurrentPageOnAdopt } from "../src/execute.ts"
import { releaseSessionTargets } from "../src/http-api.ts"
import { TargetRegistry } from "../src/target-registry.ts"

describe("target selection", () => {
  const targets = [
    { url: "https://example.com/a" },
    { url: "https://kit.example/b" },
  ]

  it("selects by URL substring and rejects ambiguous matches", () => {
    expect(selectTarget({ targets, selection: { urlIncludes: "kit.example" }, getUrl: (target) => target.url })?.url).toBe("https://kit.example/b")
    expect(() => selectTarget({ targets, selection: { urlIncludes: "example" }, getUrl: (target) => target.url })).toThrow("Multiple attached pages")
  })

  it("selects by zero-based index", () => {
    expect(selectTarget({ targets, selection: { index: 1 }, getUrl: (target) => target.url })?.url).toBe("https://kit.example/b")
  })

  it("threads the validation target URL so adoption agrees when page order differs", () => {
    const registryTargets = [
      { targetId: "target-a", url: "https://first.example" },
      { targetId: "target-b", url: "https://second.example" },
    ]
    const selectedByHttpValidation = selectTarget({
      targets: registryTargets,
      selection: { index: 1 },
      getUrl: (target) => target.url,
    })
    const playwrightPagesInDifferentOrder = [
      { targetId: "target-b", url: "https://second.example" },
      { targetId: "target-a", url: "https://first.example" },
    ]

    const adoptedBySandbox = selectAdoptCandidateByUrl({
      candidates: playwrightPagesInDifferentOrder,
      targetUrl: selectedByHttpValidation?.url ?? "",
      getUrl: (page) => page.url,
    })

    expect(selectedByHttpValidation?.url).toBe("https://second.example")
    expect(adoptedBySandbox?.url).toBe("https://second.example")
  })

  it("refuses URL-based adopt mapping when multiple Playwright pages have the validated URL", () => {
    expect(() =>
      selectAdoptCandidateByUrl({
        candidates: [{ url: "https://same.example" }, { url: "https://same.example" }],
        targetUrl: "https://same.example",
        getUrl: (page) => page.url,
      })
    ).toThrow("cannot safely map")
  })

  it("closes only a different open relay-owned page when adopting", () => {
    expect(shouldCloseCurrentPageOnAdopt({ hasCurrentPage: true, ownsCurrentPage: true, currentPageIsSelected: false, currentPageIsClosed: false })).toBe(true)
    expect(shouldCloseCurrentPageOnAdopt({ hasCurrentPage: true, ownsCurrentPage: false, currentPageIsSelected: false, currentPageIsClosed: false })).toBe(false)
    expect(shouldCloseCurrentPageOnAdopt({ hasCurrentPage: true, ownsCurrentPage: true, currentPageIsSelected: true, currentPageIsClosed: false })).toBe(false)
  })

  it("clears session ownership from released adopted targets", () => {
    const registry = new TargetRegistry()
    registry.addRootTarget({
      tabId: 1,
      sessionId: "bc-tab-1",
      browserControlSessionId: "adopted-session",
      owner: "relay",
      targetInfo: {
        targetId: "target-1",
        type: "page",
        title: "Adopted",
        url: "https://example.com/?bc-adopt-echo-703",
        attached: true,
        canAccessOpener: false,
      },
    })

    const affectedTabIds = releaseSessionTargets(registry, "adopted-session", ["target-1"])

    expect(affectedTabIds).toEqual([1])
    expect(registry.listRootTargets()[0]?.browserControlSessionId).toBeUndefined()
    expect(registry.getRootTargetBySessionId("adopted-session")?.targetInfo.targetId).toBeUndefined()
  })

  it("does not clear session ownership for relay-created targets that are being closed", () => {
    const registry = new TargetRegistry()
    registry.addRootTarget({
      tabId: 1,
      sessionId: "bc-tab-1",
      browserControlSessionId: "relay-session",
      owner: "relay",
      targetInfo: {
        targetId: "relay-created-target",
        type: "page",
        title: "Relay-created",
        url: "https://example.com/?relay-created",
        attached: true,
        canAccessOpener: false,
      },
    })

    releaseSessionTargets(registry, "relay-session", [])

    expect(registry.listRootTargets()[0]?.browserControlSessionId).toBe("relay-session")
    expect(registry.getRootTargetBySessionId("relay-session")?.targetInfo.targetId).toBe("relay-created-target")
  })

  it("returns a user-owned adopted tab for immediate status refresh", () => {
    const registry = new TargetRegistry()
    registry.addRootTarget({
      tabId: 9,
      sessionId: "bc-tab-9",
      owner: "user",
      targetInfo: {
        targetId: "user-target",
        type: "page",
        title: "User tab",
        url: "https://example.com/user",
        attached: true,
        canAccessOpener: false,
      },
    })

    expect(releaseSessionTargets(registry, "adopted-session", ["user-target"])).toEqual([9])
    expect(registry.targetsByTargetId.get("user-target")?.owner).toBe("user")
  })
})
