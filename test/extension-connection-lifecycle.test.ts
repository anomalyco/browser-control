import { afterEach, describe, expect, it, vi } from "vitest"
import {
  completeExtensionHandshake,
  ensureReconnectAlarm,
  reconnectAlarmName,
  startSocketKeepAlive,
} from "../extension/src/connection-lifecycle.ts"

describe("extension connection lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("repairs a missing reconnect alarm whenever the service worker starts", async () => {
    const create = vi.fn(async () => {})
    const get = vi.fn(async () => undefined)

    await ensureReconnectAlarm({ create, get })

    expect(get).toHaveBeenCalledWith(reconnectAlarmName)
    expect(create).toHaveBeenCalledWith(reconnectAlarmName, {
      periodInMinutes: 0.5,
    })
  })

  it("preserves an existing reconnect alarm", async () => {
    const create = vi.fn(async () => {})
    const get = vi.fn(async () => ({ name: reconnectAlarmName, scheduledTime: Date.now() }))

    await ensureReconnectAlarm({ create, get })

    expect(create).not.toHaveBeenCalled()
  })

  it("runs a heartbeat every 20 seconds and stops cleanly", () => {
    vi.useFakeTimers()
    const heartbeat = vi.fn()

    const stop = startSocketKeepAlive(heartbeat)
    vi.advanceTimersByTime(40_000)
    stop()
    vi.advanceTimersByTime(20_000)

    expect(heartbeat).toHaveBeenCalledTimes(2)
  })

  it("does not block readiness on tab-group reconciliation", () => {
    const sendReady = vi.fn()
    const reconcileGroups = vi.fn(() => new Promise<void>(() => {}))
    const reportReconciliationFailure = vi.fn()

    completeExtensionHandshake({ sendReady, reconcileGroups, reportReconciliationFailure })

    expect(sendReady).toHaveBeenCalledOnce()
    expect(reconcileGroups).toHaveBeenCalledOnce()
    expect(reportReconciliationFailure).not.toHaveBeenCalled()
  })

  it("reports tab-group reconciliation failures after readiness", async () => {
    const failure = new Error("tab groups unavailable")
    const sendReady = vi.fn()
    const reportReconciliationFailure = vi.fn()

    completeExtensionHandshake({
      sendReady,
      reconcileGroups: () => Promise.reject(failure),
      reportReconciliationFailure,
    })
    await vi.waitFor(() => expect(reportReconciliationFailure).toHaveBeenCalledWith(failure))

    expect(sendReady).toHaveBeenCalledOnce()
  })
})
