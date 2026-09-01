export const reconnectAlarmName = "browser-control-reconnect"
const reconnectAlarmPeriodMinutes = 0.5
const socketKeepAliveIntervalMs = 20_000

type AlarmApi = Pick<typeof chrome.alarms, "create" | "get">
type AddListener = (listener: () => void) => void

type HandshakeCompletion = {
  readonly announceAttachedTabs: () => Promise<void>
  readonly sendReady: () => void
  readonly startGroupReconciliation: () => void
}

export async function ensureReconnectAlarm(alarms: AlarmApi): Promise<void> {
  if (await alarms.get(reconnectAlarmName)) return
  await alarms.create(reconnectAlarmName, { periodInMinutes: reconnectAlarmPeriodMinutes })
}

export function startConnectionLifecycle(options: {
  readonly alarms: AlarmApi
  readonly addStartupListener: AddListener
  readonly addInstalledListener: AddListener
  readonly connect: () => void
}): void {
  const activate = () => {
    void ensureReconnectAlarm(options.alarms).catch(() => {})
    options.connect()
  }
  // Global startup registration is what wakes an MV3 worker after a full
  // browser restart; the alarm alone is not reliably persisted before Chrome 150.
  options.addStartupListener(activate)
  options.addInstalledListener(activate)
  activate()
}

export function startSocketKeepAlive(heartbeat: () => void): () => void {
  const timer = setInterval(heartbeat, socketKeepAliveIntervalMs)
  return () => clearInterval(timer)
}

export async function completeExtensionHandshake(options: HandshakeCompletion): Promise<void> {
  await options.announceAttachedTabs()
  options.sendReady()
  options.startGroupReconciliation()
}
