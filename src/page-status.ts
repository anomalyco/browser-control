import type { PageStatus } from "./protocol.ts"

export function makePageStatus(options: {
  readonly state: PageStatus["state"]
  readonly targetOwner: "relay" | "user"
  readonly sessionId?: string
  readonly readOnly?: boolean
  readonly message?: string
  readonly handoffId?: string
}): PageStatus {
  return {
    state: options.state,
    owner: options.targetOwner === "user" ? "user" : "session",
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.sessionId && options.readOnly ? { readOnly: true } : {}),
    ...(options.message ? { message: options.message } : {}),
    ...(options.handoffId ? { handoffId: options.handoffId } : {}),
  }
}
