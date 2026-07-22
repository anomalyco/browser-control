import { afterEach, describe, expect, it, vi } from "vitest"
import {
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
})
