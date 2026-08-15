export const reconnectAlarmName = "browser-control-reconnect"
const reconnectAlarmPeriodMinutes = 0.5
const socketKeepAliveIntervalMs = 20_000

type AlarmApi = Pick<typeof chrome.alarms, "create" | "get">

type HandshakeCompletion = {
  readonly sendReady: () => void
  readonly reconcileGroups: () => Promise<void>
  readonly reportReconciliationFailure: (error: unknown) => void
}

export async function ensureReconnectAlarm(alarms: AlarmApi): Promise<void> {
  if (await alarms.get(reconnectAlarmName)) return
  await alarms.create(reconnectAlarmName, { periodInMinutes: reconnectAlarmPeriodMinutes })
}

export function startSocketKeepAlive(heartbeat: () => void): () => void {
  const timer = setInterval(heartbeat, socketKeepAliveIntervalMs)
  return () => clearInterval(timer)
}

export function completeExtensionHandshake({ sendReady, reconcileGroups, reportReconciliationFailure }: HandshakeCompletion): void {
  sendReady()
  void reconcileGroups().catch(reportReconciliationFailure)
}
