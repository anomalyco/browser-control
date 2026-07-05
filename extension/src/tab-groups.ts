export const tabGroupTitle = "browser-control"
export const sessionTabGroupTitlePrefix = "bc:"
export const compactSessionTabGroupTitlePrefix = "bc · "
export const tabGroupColor = "purple" as const
const maxCompactGroupTitleLength = 17

export function isBrowserControlGroupTitle(title: string | undefined): boolean {
  return title === tabGroupTitle || title?.startsWith(sessionTabGroupTitlePrefix) === true || title?.startsWith(compactSessionTabGroupTitlePrefix) === true
}

export function compactBrowserControlGroupTitle(title: string): string {
  if (!title.startsWith(sessionTabGroupTitlePrefix)) {
    return title
  }
  const fullSessionId = title.slice(sessionTabGroupTitlePrefix.length)
  const displaySessionId = fullSessionId.replace(/-(?:browser-control|inspect|session)$/, "") || fullSessionId
  const generated = /^([a-z]+)-([a-z]+)-(\d{3})$/.exec(displaySessionId)
  const label = generated
    ? `${generated[1]?.slice(0, 3)}-${generated[2]?.slice(0, 3)}-${generated[3]}`
    : displaySessionId
  if (compactSessionTabGroupTitlePrefix.length + label.length <= maxCompactGroupTitleLength) {
    return `${compactSessionTabGroupTitlePrefix}${label}`
  }
  const available = maxCompactGroupTitleLength - compactSessionTabGroupTitlePrefix.length
  const suffixLength = 4
  const prefixLength = available - suffixLength - 1
  return `${compactSessionTabGroupTitlePrefix}${label.slice(0, prefixLength)}…${label.slice(-suffixLength)}`
}

export function shouldUngroupBrowserControlTab(groupTitle: string | undefined): boolean {
  return isBrowserControlGroupTitle(groupTitle)
}
