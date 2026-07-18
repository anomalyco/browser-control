/** The relay, not the shim, decides whether a debugger detach removed the root page. */
export function debuggerDetachedEvent(options: {
  readonly tabId: number
  readonly reason: string
  readonly sessionId?: string
}) {
  return {
    method: "debugger.detached" as const,
    params: {
      tabId: options.tabId,
      reason: options.reason,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    },
  }
}
