import { Effect } from "effect"
import { WebSocket } from "ws"
import type { ExtensionCommand, ExtensionResponse, JsonObject } from "./protocol.ts"
import type { PendingExtensionRequest } from "./relay-types.ts"

export type ExtensionRpcTimeouts = {
  readonly commandTimeoutMs?: number
  readonly debuggerCommandTimeoutMs?: number
  readonly livenessProbeTimeoutMs?: number
}

/**
 * Request/response correlator for the single extension websocket.
 *
 * A timed-out command fails only that command. Connection teardown is reserved
 * for a failed websocket-level liveness probe, so one hung debugger command
 * (for example a dialog-blocked tab) cannot destroy every attached tab's relay
 * state.
 */
export class ExtensionRpc {
  private socket: WebSocket | undefined
  private ready = false
  private nextRequestId = 1
  private readonly pendingRequests = new Map<number, PendingExtensionRequest>()
  private livenessProbe: NodeJS.Timeout | undefined
  version: string | undefined

  constructor(private readonly timeouts: ExtensionRpcTimeouts = {}) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.ready
  }

  replaceSocket(socket: WebSocket): void {
    this.rejectPending(new Error("Extension replaced"))
    this.cancelLivenessProbe()
    this.socket?.close(4001, "Extension replaced")
    this.socket = socket
    this.ready = false
    this.version = undefined
  }

  markReady(version: string | undefined): void {
    this.ready = true
    this.version = version
  }

  disconnectIfCurrent(socket: WebSocket): boolean {
    if (this.socket !== socket) {
      return false
    }
    this.socket = undefined
    this.ready = false
    this.version = undefined
    this.cancelLivenessProbe()
    this.rejectPending(new Error("Extension disconnected"))
    return true
  }

  close(): void {
    this.cancelLivenessProbe()
    this.socket?.close()
  }

  rejectPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout)
      this.pendingRequests.delete(id)
      pending.reject(error)
    }
  }

  rejectDebuggerCommandsForTab(tabId: number, error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.debuggerTabId !== tabId) {
        continue
      }
      clearTimeout(pending.timeout)
      this.pendingRequests.delete(id)
      pending.reject(error)
    }
  }

  handleResponse(response: ExtensionResponse): boolean {
    const pending = this.pendingRequests.get(response.id)
    if (!pending) {
      return false
    }
    clearTimeout(pending.timeout)
    this.pendingRequests.delete(response.id)
    if (response.error) {
      pending.reject(new Error(response.error))
      return true
    }
    pending.resolve(response.result ?? {})
    return true
  }

  send(command: Omit<ExtensionCommand, "id">): Effect.Effect<JsonObject, Error> {
    return Effect.callback<JsonObject, Error>((resume) => {
      const socket = this.socket
      if (!socket || socket.readyState !== WebSocket.OPEN || !this.ready) {
        resume(Effect.fail(new Error("Browser Control extension is not connected")))
        return Effect.void
      }

      const id = this.nextRequestId++
      const message: ExtensionCommand = { ...command, id }
      let completed = false
      const timeoutMs = command.method === "debugger.sendCommand"
        ? this.timeouts.debuggerCommandTimeoutMs ?? 60_000
        : this.timeouts.commandTimeoutMs ?? 15_000
      const finish = (effect: Effect.Effect<JsonObject, Error>) => {
        if (completed) {
          return
        }
        completed = true
        clearTimeout(timeout)
        this.pendingRequests.delete(id)
        resume(effect)
      }
      const timeout = setTimeout(() => {
        // Fail only this command. Close the socket only if the websocket
        // itself is unresponsive to a protocol-level ping.
        this.probeLiveness(socket)
        finish(Effect.fail(new Error(`Extension command timed out after ${timeoutMs}ms: ${command.method}`)))
      }, timeoutMs)
      const debuggerTabId = command.method === "debugger.sendCommand" && typeof command.params?.tabId === "number"
        ? command.params.tabId
        : undefined
      this.pendingRequests.set(id, {
        resolve: (value) => {
          finish(Effect.succeed(value))
        },
        reject: (error) => {
          finish(Effect.fail(error))
        },
        timeout,
        ...(debuggerTabId === undefined ? {} : { debuggerTabId }),
      })
      try {
        socket.send(JSON.stringify(message), (error) => {
          if (error) {
            finish(Effect.fail(new Error(`send extension command: ${command.method}`, { cause: error })))
          }
        })
      } catch (error) {
        finish(Effect.fail(new Error(`send extension command: ${command.method}`, { cause: error })))
      }
      return Effect.sync(() => {
        completed = true
        clearTimeout(timeout)
        this.pendingRequests.delete(id)
      })
    })
  }

  private probeLiveness(socket: WebSocket): void {
    if (this.socket !== socket || this.livenessProbe || socket.readyState !== WebSocket.OPEN) {
      return
    }
    const probeTimeoutMs = this.timeouts.livenessProbeTimeoutMs ?? 10_000
    const onPong = () => {
      this.cancelLivenessProbe()
      socket.off("pong", onPong)
    }
    this.livenessProbe = setTimeout(() => {
      this.livenessProbe = undefined
      socket.off("pong", onPong)
      socket.close(4002, "Extension websocket did not answer liveness probe")
    }, probeTimeoutMs)
    socket.on("pong", onPong)
    try {
      socket.ping()
    } catch {
      // If ping cannot be sent the socket is already failing; let the probe
      // timeout close it.
    }
  }

  private cancelLivenessProbe(): void {
    if (this.livenessProbe) {
      clearTimeout(this.livenessProbe)
      this.livenessProbe = undefined
    }
  }
}
