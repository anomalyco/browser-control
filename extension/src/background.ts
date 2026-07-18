import { parseExtensionCommand, type ExtensionCommand as ShimCommand, type JsonObject } from "../../src/protocol.ts"
import type {
  OffscreenCancelRecordingResult,
  OffscreenOutgoingMessage,
  OffscreenStartRecordingResult,
  OffscreenStatusRecordingResult,
  OffscreenStopRecordingResult,
} from "./recording-types.ts"
import { isBrowserControlGroupTitle, isCurrentBrowserControlGroupTitle, isLegacyBrowserControlGroupTitle, shouldUngroupBrowserControlTab, tabGroupColor, tabGroupTitle } from "./tab-groups.ts"
import { pageStatusFromJson } from "./page-status.ts"
import { debuggerDetachedEvent } from "./debugger-detach.ts"

const relayHost = "127.0.0.1"
const relayPort = 19989
const shimVersion = "0.0.17"
const offscreenDocumentPath = "offscreen.html"

let socket: WebSocket | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let offscreenDocumentCreating: Promise<void> | undefined
const activeRecordings = new Map<number, { readonly startedAt: number }>()

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("browser-control-reconnect", { periodInMinutes: 0.5 })
})

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("browser-control-reconnect", { periodInMinutes: 0.5 })
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "browser-control-reconnect") {
    return
  }
  void ensureConnection().catch(() => {})
})

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) {
    return
  }
  sendMessage({ method: "toolbar.clicked", params: { tabId: tab.id } })
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) {
    return
  }
  sendMessage({
    method: "debugger.event",
    params: {
      tabId: source.tabId,
      method,
      params: toJsonObject(params),
      ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
    },
  })
})

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source.tabId) {
    return
  }
  const sourceSession = source as chrome.debugger.DebuggerSession
  sendMessage(debuggerDetachedEvent({
    tabId: source.tabId,
    reason,
    ...(sourceSession.sessionId === undefined ? {} : { sessionId: sourceSession.sessionId }),
  }))
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void cleanupRecordingForTab(tabId)
  void guardedUngroupBrowserControlTab(tabId)
  sendMessage({ method: "tabs.removed", params: { tabId } })
})

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  handleRuntimeMessage(message, sender)
  return false
})

connect()
void reconcileBrowserControlGroups().catch(() => {})

function connect(): void {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    return
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }
  const currentSocket = new WebSocket(`ws://${relayHost}:${relayPort}/extension`)
  socket = currentSocket
  currentSocket.onopen = announceHelloAndAttachedTabs
  currentSocket.onmessage = (event) => {
    void handleSocketMessage(event.data)
  }
  currentSocket.onclose = () => {
    if (socket !== currentSocket) {
      return
    }
    void cancelAllRecordings()
    socket = undefined
    reconnectTimer = setTimeout(connect, 1000)
  }
}

async function ensureConnection(): Promise<void> {
  if (socket?.readyState === WebSocket.OPEN) {
    return
  }
  connect()
  await new Promise<void>((resolve, reject) => {
    const current = socket
    if (!current) {
      reject(new Error("No socket"))
      return
    }
    const timeout = setTimeout(() => {
      reject(new Error("Relay connection timed out"))
    }, 5000)
    if (current.readyState === WebSocket.OPEN) {
      clearTimeout(timeout)
      resolve()
      return
    }
    current.onopen = () => {
      clearTimeout(timeout)
      announceHelloAndAttachedTabs()
      resolve()
    }
    current.onerror = () => {
      clearTimeout(timeout)
      reject(new Error("Relay connection failed"))
    }
  })
}

function announceHelloAndAttachedTabs(): void {
  sendMessage({ method: "hello", params: { version: shimVersion } })
  void reannounceAttachedTabsAndReconcileGroups().catch((error: unknown) => {
    sendMessage({ method: "log", params: { level: "error", message: `Failed to re-announce attached tabs and reconcile groups: ${error instanceof Error ? error.message : String(error)}` } })
  })
}

async function reannounceAttachedTabsAndReconcileGroups(): Promise<void> {
  const attachedTabIds = new Set<number>()
  const targets = await chrome.debugger.getTargets()
  for (const target of targets) {
    if (target.attached && typeof target.tabId === "number") {
      attachedTabIds.add(target.tabId)
      sendMessage({ method: "debugger.attached", params: { tabId: target.tabId } })
    }
  }
  await reconcileBrowserControlGroups(attachedTabIds)
}

async function handleSocketMessage(data: unknown): Promise<void> {
  let command: ShimCommand
  try {
    command = parseExtensionCommand(String(data))
  } catch (error) {
    sendMessage({ method: "log", params: { level: "error", message: error instanceof Error ? error.message : String(error) } })
    return
  }
  try {
    const result = await handleCommand(command)
    sendMessage({ id: command.id, result })
  } catch (error) {
    sendMessage({ id: command.id, error: error instanceof Error ? error.message : String(error) })
  }
}

async function handleCommand(command: ShimCommand): Promise<JsonObject> {
  if (command.method === "ping") {
    sendMessage({ method: "pong" })
    return {}
  }
  if (command.method === "debugger.attach") {
    const tabId = numberParam(command.params, "tabId")
    try {
      await chrome.debugger.attach({ tabId }, "1.3")
    } catch (error) {
      if (!isAlreadyAttachedError(error)) {
        throw error
      }
    }
    return {}
  }
  if (command.method === "debugger.detach") {
    const tabId = numberParam(command.params, "tabId")
    await chrome.debugger.detach({ tabId })
    await guardedUngroupBrowserControlTab(tabId)
    return {}
  }
  if (command.method === "debugger.sendCommand") {
    const tabId = numberParam(command.params, "tabId")
    const cdpMethod = stringParam(command.params, "method")
    const params = objectParam(command.params, "params")
    const sessionId = optionalStringParam(command.params, "sessionId")
    const debuggee: chrome.debugger.DebuggerSession = { tabId, ...(sessionId === undefined ? {} : { sessionId }) }
    return toJsonObject(await chrome.debugger.sendCommand(debuggee, cdpMethod, params))
  }
  if (command.method === "tabs.create") {
    const url = optionalStringParam(command.params, "url") ?? "about:blank"
    const active = optionalBooleanParam(command.params, "active") ?? false
    const tab = await chrome.tabs.create({ url, active })
    if (!tab.id) {
      throw new Error("Created tab has no id")
    }
    return { tabId: tab.id }
  }
  if (command.method === "tabs.remove") {
    const tabId = numberParam(command.params, "tabId")
    await chrome.tabs.remove(tabId)
    return {}
  }
  if (command.method === "tabs.group") {
    const tabId = numberParam(command.params, "tabId")
    const tab = await chrome.tabs.get(tabId)
    if (tab.groupId !== undefined && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      const currentGroup = await chrome.tabGroups.get(tab.groupId)
      if (currentGroup.title === tabGroupTitle && currentGroup.color === tabGroupColor) {
        return { groupId: currentGroup.id }
      }
    }
    const attachedTabIds = await getAttachedTabIds()
    let existingGroup: chrome.tabGroups.TabGroup | undefined
    for (const group of await chrome.tabGroups.query({ windowId: tab.windowId })) {
      if (group.title !== tabGroupTitle || group.color !== tabGroupColor) {
        continue
      }
      const groupedTabs = await chrome.tabs.query({ groupId: group.id })
      if (groupedTabs.some((groupedTab) => typeof groupedTab.id === "number" && attachedTabIds.has(groupedTab.id))) {
        existingGroup = group
        break
      }
    }
    const groupId = await chrome.tabs.group({
      tabIds: [tabId],
      ...(existingGroup ? { groupId: existingGroup.id } : {}),
    })
    await chrome.tabGroups.update(groupId, { title: tabGroupTitle, color: tabGroupColor })
    return { groupId }
  }
  if (command.method === "tabs.ungroup") {
    const tabId = numberParam(command.params, "tabId")
    await guardedUngroupBrowserControlTab(tabId)
    return {}
  }
  if (command.method === "action.setAttached") {
    const tabId = numberParam(command.params, "tabId")
    const attached = Boolean(command.params?.attached)
    await chrome.action.setBadgeText({ tabId, text: attached ? "ON" : "" })
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#7c3aed" })
    await chrome.action.setTitle({ tabId, title: attached ? "Detach from Browser Control" : "Attach to Browser Control" })
    return {}
  }
  if (command.method === "action.setBadge") {
    const tabId = numberParam(command.params, "tabId")
    const text = optionalStringParam(command.params, "text") ?? ""
    const color = optionalStringParam(command.params, "color") ?? "#7c3aed"
    const title = optionalStringParam(command.params, "title")
    await chrome.action.setBadgeText({ tabId, text })
    await chrome.action.setBadgeBackgroundColor({ tabId, color })
    if (title !== undefined) {
      await chrome.action.setTitle({ tabId, title })
    }
    return {}
  }
  if (command.method === "pageStatus.set") {
    const tabId = numberParam(command.params, "tabId")
    const status = pageStatusFromJson(objectParam(command.params, "status"))
    if (!status) {
      throw new Error("Invalid page status")
    }
    await sendPageStatusMessage(tabId, { action: "page-status.set", status })
    return {}
  }
  if (command.method === "pageStatus.clear") {
    const tabId = numberParam(command.params, "tabId")
    await sendPageStatusMessage(tabId, { action: "page-status.clear" })
    return {}
  }
  if (command.method === "runtime.reload") {
    chrome.runtime.reload()
    return {}
  }
  if (command.method === "recording.start") {
    return startRecording(command.params)
  }
  if (command.method === "recording.stop") {
    return stopRecording(command.params)
  }
  if (command.method === "recording.status") {
    return statusRecording(command.params)
  }
  if (command.method === "recording.cancel") {
    return cancelRecording(command.params)
  }
  throw new Error(`Unknown shim command: ${command.method}`)
}

async function startRecording(params: JsonObject | undefined): Promise<JsonObject> {
  const tabId = numberParam(params, "tabId")
  if (activeRecordings.has(tabId)) {
    return { success: false, error: "Recording already in progress for this tab" }
  }
  await ensureOffscreenDocument()
  const streamId = await getTabCaptureStreamId(tabId)
  const result = await chrome.runtime.sendMessage({
    action: "recording.start",
    tabId,
    streamId,
    frameRate: optionalNumberParam(params, "frameRate") ?? 30,
    videoBitsPerSecond: optionalNumberParam(params, "videoBitsPerSecond") ?? 2_500_000,
    audioBitsPerSecond: optionalNumberParam(params, "audioBitsPerSecond") ?? 128_000,
    audio: optionalBooleanParam(params, "audio") ?? false,
  }) as OffscreenStartRecordingResult
  if (!result.success) {
    return { success: false, error: result.error }
  }
  activeRecordings.set(tabId, { startedAt: result.startedAt })
  return { success: true, tabId: result.tabId, startedAt: result.startedAt, mimeType: result.mimeType }
}

async function stopRecording(params: JsonObject | undefined): Promise<JsonObject> {
  const tabId = numberParam(params, "tabId")
  if (!activeRecordings.has(tabId)) {
    return { success: false, error: "No active recording for this tab" }
  }
  const result = await chrome.runtime.sendMessage({ action: "recording.stop", tabId }) as OffscreenStopRecordingResult
  if (!result.success) {
    return { success: false, error: result.error }
  }
  activeRecordings.delete(tabId)
  return { success: true, tabId: result.tabId, duration: result.duration }
}

async function statusRecording(params: JsonObject | undefined): Promise<JsonObject> {
  const tabId = numberParam(params, "tabId")
  const recording = activeRecordings.get(tabId)
  if (!recording) {
    return { isRecording: false, tabId }
  }
  try {
    const result = await chrome.runtime.sendMessage({ action: "recording.status", tabId }) as OffscreenStatusRecordingResult
    return {
      isRecording: result.isRecording,
      tabId,
      ...(result.startedAt === undefined ? { startedAt: recording.startedAt } : { startedAt: result.startedAt }),
    }
  } catch {
    activeRecordings.delete(tabId)
    return { isRecording: false, tabId }
  }
}

async function cancelRecording(params: JsonObject | undefined): Promise<JsonObject> {
  const tabId = numberParam(params, "tabId")
  return cancelRecordingForTab(tabId)
}

async function cancelRecordingForTab(tabId: number): Promise<JsonObject> {
  if (!activeRecordings.has(tabId)) {
    return { success: true }
  }
  const result = await chrome.runtime.sendMessage({ action: "recording.cancel", tabId }) as OffscreenCancelRecordingResult
  activeRecordings.delete(tabId)
  if (!result.success) {
    return { success: false, error: result.error }
  }
  return { success: true }
}

async function cleanupRecordingForTab(tabId: number): Promise<void> {
  try {
    await cancelRecordingForTab(tabId)
  } catch {
    activeRecordings.delete(tabId)
  }
}

async function cancelAllRecordings(): Promise<void> {
  await Promise.all(Array.from(activeRecordings.keys()).map(async (tabId) => {
    await cleanupRecordingForTab(tabId)
  }))
}

async function ensureOffscreenDocument(): Promise<void> {
  const documentUrl = chrome.runtime.getURL(offscreenDocumentPath)
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [documentUrl],
  })
  if (existingContexts.length > 0) {
    return
  }
  if (offscreenDocumentCreating) {
    return offscreenDocumentCreating
  }
  offscreenDocumentCreating = chrome.offscreen.createDocument({
    url: offscreenDocumentPath,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Record Browser Control tabs with chrome.tabCapture and MediaRecorder",
  })
  try {
    await offscreenDocumentCreating
  } finally {
    offscreenDocumentCreating = undefined
  }
}

async function getTabCaptureStreamId(tabId: number): Promise<string> {
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("Extension has not been invoked") || message.includes("activeTab")) {
      throw new Error(`${message}. Click the Browser Control extension icon on this tab once before recording.`)
    }
    throw error
  }
}

async function reconcileBrowserControlGroups(knownAttachedTabIds?: ReadonlySet<number>): Promise<void> {
  if (!chrome.tabGroups) {
    return
  }
  const attachedTabIds = knownAttachedTabIds ?? await getAttachedTabIds()
  const groups = await chrome.tabGroups.query({})
  for (const group of groups) {
    if (!isCurrentBrowserControlGroupTitle(group.title) && !isLegacyBrowserControlGroupTitle(group.title)) {
      continue
    }
    const tabs = await chrome.tabs.query({ groupId: group.id })
    for (const tab of tabs) {
      if (typeof tab.id !== "number") {
        continue
      }
      if (attachedTabIds.has(tab.id)) {
        continue
      }
      await guardedUngroupBrowserControlTab(tab.id)
    }
  }
}

async function getAttachedTabIds(): Promise<Set<number>> {
  const attachedTabIds = new Set<number>()
  const targets = await chrome.debugger.getTargets()
  for (const target of targets) {
    if (target.attached && typeof target.tabId === "number") {
      attachedTabIds.add(target.tabId)
    }
  }
  return attachedTabIds
}

async function guardedUngroupBrowserControlTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.groupId === undefined || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      return
    }
    let groupTitle: string | undefined
    if (chrome.tabGroups) {
      const group = await chrome.tabGroups.get(tab.groupId)
      groupTitle = group.title
    }
    if (!shouldUngroupBrowserControlTab(groupTitle)) {
      return
    }
    await chrome.tabs.ungroup(tabId)
  } catch {
    // Tabs and groups can disappear while detach/close/reconnect cleanup is racing
    // the browser. Ungrouping is best-effort because stale groups are reconciled
    // again on service-worker startup and relay reconnect.
  }
}

function handleRuntimeMessage(message: unknown, sender: chrome.runtime.MessageSender): void {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return
  }
  const pageStatusMessage = message as { readonly action?: unknown; readonly handoffId?: unknown }
  if (pageStatusMessage.action === "page-status.ready") {
    if (typeof sender.tab?.id === "number") {
      sendMessage({ method: "pageStatus.requested", params: { tabId: sender.tab.id } })
    }
    return
  }
  if (pageStatusMessage.action === "handoff.complete") {
    if (typeof sender.tab?.id === "number" && typeof pageStatusMessage.handoffId === "string") {
      sendMessage({ method: "handoff.completed", params: { tabId: sender.tab.id, handoffId: pageStatusMessage.handoffId } })
    }
    return
  }
  const offscreenMessage = message as OffscreenOutgoingMessage
  if (offscreenMessage.action === "recording.chunk") {
    if (offscreenMessage.data) {
      sendMessage({ method: "recording.data", params: { tabId: offscreenMessage.tabId } })
      sendBinary(Uint8Array.from(offscreenMessage.data))
      return
    }
    if (offscreenMessage.final) {
      sendMessage({ method: "recording.data", params: { tabId: offscreenMessage.tabId, final: true } })
    }
    return
  }
  if (offscreenMessage.action === "recording.cancelled") {
    activeRecordings.delete(offscreenMessage.tabId)
    sendMessage({ method: "recording.cancelled", params: { tabId: offscreenMessage.tabId } })
  }
}

async function sendPageStatusMessage(tabId: number, message: JsonObject): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message)
  } catch {
    // Restricted pages do not accept content scripts. Visibility is best-effort
    // and must never interfere with debugger attachment or detachment.
  }
}

function sendMessage(message: JsonObject): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message))
    return
  }
  void ensureConnection().then(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message))
    }
  })
}

function sendBinary(data: Uint8Array): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(data.buffer)
  }
}

function isAlreadyAttachedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("Another debugger is already attached") || message.includes("Debugger is already attached")
}

function numberParam(params: JsonObject | undefined, key: string): number {
  const value = params?.[key]
  if (typeof value !== "number") {
    throw new Error(`Missing number param: ${key}`)
  }
  return value
}

function stringParam(params: JsonObject | undefined, key: string): string {
  const value = params?.[key]
  if (typeof value !== "string") {
    throw new Error(`Missing string param: ${key}`)
  }
  return value
}

function optionalStringParam(params: JsonObject | undefined, key: string): string | undefined {
  const value = params?.[key]
  return typeof value === "string" ? value : undefined
}

function optionalBooleanParam(params: JsonObject | undefined, key: string): boolean | undefined {
  const value = params?.[key]
  return typeof value === "boolean" ? value : undefined
}

function optionalNumberParam(params: JsonObject | undefined, key: string): number | undefined {
  const value = params?.[key]
  return typeof value === "number" ? value : undefined
}

function objectParam(params: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = params?.[key]
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value
}

function toJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }
  return value as JsonObject
}
