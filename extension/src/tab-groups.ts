const tabGroupVisibleTitle = "control"
const tabGroupMarker = "\u2063"
// Keep the fallback label generic without treating a user's own `control` group
// as extension-owned. Chrome renders U+2063 without visible width.
export const tabGroupTitle = `${tabGroupVisibleTitle}${tabGroupMarker}`
const legacyTabGroupTitle = "browser-control"
const sessionTabGroupTitlePrefix = "bc:"
const compactSessionTabGroupTitlePrefix = "bc · "
export const tabGroupColor = "purple" as const

const mascotEmojiByNoun: Readonly<Record<string, string>> = {
  badger: "🦡",
  comet: "☄️",
  falcon: "🦅",
  otter: "🦦",
  panda: "🐼",
  raven: "🐦‍⬛",
  sparrow: "🐦",
  tiger: "🐯",
  walrus: "🦭",
  wombat: "🐨",
}

const fallbackEmojis = ["🦦", "🦅", "🦡", "🐼", "🐯", "☄️", "🦭", "🐦"] as const

export function sessionEmoji(sessionId: string | undefined): string {
  if (!sessionId) return "🦦"
  const lower = sessionId.toLowerCase()
  for (const [noun, emoji] of Object.entries(mascotEmojiByNoun)) {
    if (lower.includes(noun)) return emoji
  }
  let hash = 0
  for (let i = 0; i < lower.length; i += 1) {
    hash = (hash * 31 + lower.charCodeAt(i)) | 0
  }
  return fallbackEmojis[Math.abs(hash) % fallbackEmojis.length] ?? "🦦"
}

export function formatSessionShortName(sessionId: string | undefined): string {
  if (!sessionId) return "control"
  const generatedMatch = /^([a-z]+)-([a-z]+)-\d{2,4}$/i.exec(sessionId)
  if (generatedMatch) {
    return `${generatedMatch[1]} ${generatedMatch[2]}`.toLowerCase()
  }
  if (/^mcp-[0-9a-f]{6,}$/i.test(sessionId)) {
    return "agent"
  }
  return sessionId.replace(/[-_]+/g, " ").trim().slice(0, 18) || "control"
}

function formatDomainShortName(rawUrl: string | undefined): string | undefined {
  if (!rawUrl || rawUrl === "about:blank" || rawUrl.startsWith("chrome")) return undefined
  try {
    const parsed = new URL(rawUrl)
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return parsed.port ? `localhost:${parsed.port}` : "localhost"
    }
    const host = parsed.hostname
      .replace(/^(www|app|dash|dashboard|console|portal|my|m)\./i, "")
    const parts = host.split(".").filter(Boolean)
    const primary = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
    return primary ? primary.slice(0, 16) : undefined
  } catch {
    return undefined
  }
}

export function formatTabGroupTitle(options?: {
  readonly sessionId?: string
  readonly url?: string
}): string {
  const sessionId = options?.sessionId
  const domain = formatDomainShortName(options?.url)
  if (!sessionId && !domain) {
    return tabGroupTitle
  }
  const emoji = sessionEmoji(sessionId ?? domain)
  const isGeneratedOrMcp = !sessionId
    || /^[a-z]+-[a-z]+-\d{2,4}$/i.test(sessionId)
    || /^mcp-[0-9a-f]{6,}$/i.test(sessionId)
  const label = isGeneratedOrMcp
    ? (domain ?? formatSessionShortName(sessionId))
    : formatSessionShortName(sessionId)
  return `${emoji} ${label}${tabGroupMarker}`
}

function isCurrentBrowserControlGroupTitle(title: string | undefined): boolean {
  return Boolean(title && title.endsWith(tabGroupMarker))
}

function isLegacyBrowserControlGroupTitle(title: string | undefined): boolean {
  return title === legacyTabGroupTitle || title?.startsWith(sessionTabGroupTitlePrefix) === true || title?.startsWith(compactSessionTabGroupTitlePrefix) === true
}

export function isBrowserControlGroupTitle(title: string | undefined): boolean {
  return isCurrentBrowserControlGroupTitle(title) || isLegacyBrowserControlGroupTitle(title)
}

export async function finalizeBrowserControlGrouping(options: {
  readonly assertCurrent: () => void
  readonly update: () => Promise<void>
  readonly rollback: () => Promise<void>
}): Promise<void> {
  try {
    options.assertCurrent()
  } catch (error) {
    // chrome.tabs.group mutates before it resolves, so a stale command must
    // remove that anonymous group before the newer per-tab command can run.
    await options.rollback().catch(() => {})
    throw error
  }
  await options.update()
}
