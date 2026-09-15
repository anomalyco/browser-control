/** Chrome's attached flag includes DevTools and other extensions. */
export async function getOwnedDebuggerTabIds(api: Pick<typeof chrome.debugger, "getTargets" | "sendCommand">): Promise<Set<number>> {
  const ids = new Set<number>()
  for (const target of await api.getTargets()) {
    if (!target.attached || typeof target.tabId !== "number") continue
    try {
      await api.sendCommand({ tabId: target.tabId }, "Target.getTargetInfo")
      ids.add(target.tabId)
    } catch (error) {
      // A global attachment is not proof of ownership by this extension.
      if (!(error instanceof Error) || !error.message.includes("Debugger is not attached to the tab")) throw error
    }
  }
  return ids
}
