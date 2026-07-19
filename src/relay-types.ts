import type { Effect, Semaphore } from "effect"
import type { AdoptTarget, ExecuteOptions, ExecuteResult } from "./execute.ts"
import type { NetworkCaptureOptions, NetworkCaptureResult, NetworkCaptureStatus, NetworkCaptureStopOptions } from "./network-capture.ts"
import type { JsonObject, TargetInfo } from "./protocol.ts"
import type { SessionSummary } from "./relay-schema.ts"

export type ConnectedTarget = {
  readonly tabId: number
  readonly sessionId: string
  /**
   * The Browser Control session the tab was created for. Owned tabs are
   * visible only to that session's CDP clients; unowned tabs (user
   * toolbar-attached or raw-client-created) are visible to every client.
   */
  readonly browserControlSessionId?: string
  readonly targetInfo: TargetInfo
  readonly owner: "relay" | "user"
  readonly crashed?: boolean
}

export type ChildTarget = {
  readonly tabId: number
  readonly sessionId: string
  readonly parentSessionId: string
  readonly targetInfo: TargetInfo
  readonly waitingForDebugger: boolean
}

export type StoredFrameEvents = {
  readonly frameId: string
  readonly attached?: JsonObject
  readonly navigated?: JsonObject
}

export type PendingExtensionRequest = {
  readonly resolve: (value: JsonObject) => void
  readonly reject: (error: Error) => void
  readonly timeout: NodeJS.Timeout
  readonly debuggerTabId?: number
}

/**
 * The sandbox seam used by session management. `ExecuteSandbox` is the real
 * implementation; tests can substitute a fake.
 */
export interface ExecuteSandboxLike {
  execute(code: string, options?: ExecuteOptions): Effect.Effect<ExecuteResult>
  adoptPage(target: AdoptTarget): Effect.Effect<string, Error>
  close(): Effect.Effect<void, Error>
  /** Adoption rollback cleanup does not settle before started Playwright close promises settle. */
  closeSettled(): Effect.Effect<void, Error>
  networkStart(options?: NetworkCaptureOptions): Effect.Effect<NetworkCaptureStatus, Error>
  networkStatus(): NetworkCaptureStatus
  networkStop(options?: NetworkCaptureStopOptions): Effect.Effect<NetworkCaptureResult, Error>
  networkCancel(): Effect.Effect<{ readonly cancelled: boolean }>
  authRefresh(options: { readonly name: string; readonly urlFilter?: string; readonly timeoutMs?: number }): Effect.Effect<NetworkCaptureResult, Error>
  redactNetworkCaptureText(text: string): string
  markTargetCrashed(targetId: string): boolean
  markTargetDetached(targetId: string): boolean
  getStatus(): {
    readonly sessionId?: string
    readonly connected: boolean
    readonly pageUrl: string | null
    readonly stateKeys: string[]
  }
}

export type BrowserControlSession = {
  readonly id: string
  readonly createdAt: string
  readonly readOnly: boolean
  readonly sandbox: ExecuteSandboxLike
  readonly executeSemaphore: Semaphore.Semaphore
  /** The adopted default-page pointer. Target ownership lives in TargetRegistry. */
  adoptedTargetId?: string
  updatedAt: string
}

export type { SessionSummary }

export type RelayServer = {
  readonly url: string
  readonly close: () => Effect.Effect<void>
}
