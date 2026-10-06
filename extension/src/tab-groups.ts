const tabGroupVisibleTitle = "control"
const tabGroupMarker = "\u2063"
// Keep the fallback label generic without treating a user's own `control` group
// as extension-owned. Chrome renders U+2063 without visible width.
export const tabGroupTitle = `${tabGroupVisibleTitle}${tabGroupMarker}`
const legacyTabGroupTitle = "browser-control"
const sessionTabGroupTitlePrefix = "bc:"
const compactSessionTabGroupTitlePrefix = "bc · "
export const tabGroupColor = "purple" as const

export function formatSessionLabel(sessionId: string | undefined): string {
  const trimmed = sessionId?.trim().slice(0, 24)
  return trimmed || tabGroupVisibleTitle
}

export function formatTabGroupTitle(sessionId?: string): string {
  return `${formatSessionLabel(sessionId)}${tabGroupMarker}`
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
