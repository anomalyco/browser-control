import { afterEach, describe, expect, it, vi } from "vitest"
import {
  completeExtensionHandshake,
  ensureReconnectAlarm,
  reconnectAlarmName,
  startConnectionLifecycle,
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

  it("wakes and reconnects when the browser profile starts", () => {
    let onStartup: (() => void) | undefined
    const connect = vi.fn()
    const getAlarm = vi.fn(async () => undefined)

    startConnectionLifecycle({
      alarms: {
        create: vi.fn(async () => {}),
        get: getAlarm,
      },
      addStartupListener: (listener) => { onStartup = listener },
      connect,
    })

    expect(connect).toHaveBeenCalledTimes(1)
    expect(getAlarm).toHaveBeenCalledTimes(1)
    onStartup?.()
    expect(connect).toHaveBeenCalledTimes(2)
    expect(getAlarm).toHaveBeenCalledTimes(2)
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

  it("announces attached tabs before ready without waiting for group reconciliation", async () => {
    let finishInventory: (() => void) | undefined
    const inventory = new Promise<void>((resolve) => {
      finishInventory = resolve
    })
    const events: string[] = []
    const reconciliation = new Promise<void>(() => {})

    const handshake = completeExtensionHandshake({
      announceAttachedTabs: async () => {
        events.push("inventory-started")
        await inventory
        events.push("inventory-finished")
      },
      sendReady: () => events.push("ready"),
      startGroupReconciliation: () => {
        events.push("groups-started")
        void reconciliation
      },
    })

    await Promise.resolve()
    expect(events).toEqual(["inventory-started"])
    finishInventory?.()
    await handshake
    expect(events).toEqual(["inventory-started", "inventory-finished", "ready", "groups-started"])
  })
})
