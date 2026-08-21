export const tabGroupVisibleTitle = "control"
// Keep the visible label generic without treating a user's own `control` group
// as extension-owned. Chrome renders U+2063 without visible width.
export const tabGroupTitle = `${tabGroupVisibleTitle}\u2063`
export const legacyTabGroupTitle = "browser-control"
export const sessionTabGroupTitlePrefix = "bc:"
export const compactSessionTabGroupTitlePrefix = "bc · "
export const tabGroupColor = "purple" as const

export function isCurrentBrowserControlGroupTitle(title: string | undefined): boolean {
  return title === tabGroupTitle
}

export function isLegacyBrowserControlGroupTitle(title: string | undefined): boolean {
  return title === legacyTabGroupTitle || title?.startsWith(sessionTabGroupTitlePrefix) === true || title?.startsWith(compactSessionTabGroupTitlePrefix) === true
}

export function isBrowserControlGroupTitle(title: string | undefined): boolean {
  return isCurrentBrowserControlGroupTitle(title) || isLegacyBrowserControlGroupTitle(title)
}

export function shouldUngroupBrowserControlTab(groupTitle: string | undefined): boolean {
  return isBrowserControlGroupTitle(groupTitle)
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
