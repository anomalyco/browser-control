export const reconnectAlarmName = "browser-control-reconnect"
const reconnectAlarmPeriodMinutes = 0.5
const socketKeepAliveIntervalMs = 20_000

type AlarmApi = Pick<typeof chrome.alarms, "create" | "get">

export async function ensureReconnectAlarm(alarms: AlarmApi): Promise<void> {
  if (await alarms.get(reconnectAlarmName)) return
  await alarms.create(reconnectAlarmName, { periodInMinutes: reconnectAlarmPeriodMinutes })
}

export function startSocketKeepAlive(heartbeat: () => void): () => void {
  const timer = setInterval(heartbeat, socketKeepAliveIntervalMs)
  return () => clearInterval(timer)
}
