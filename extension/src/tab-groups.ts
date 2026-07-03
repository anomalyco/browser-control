export const tabGroupTitle = "browser-control"
export const sessionTabGroupTitlePrefix = "bc:"
export const tabGroupColor = "purple" as const

export function isBrowserControlGroupTitle(title: string | undefined): boolean {
  return title === tabGroupTitle || title?.startsWith(sessionTabGroupTitlePrefix) === true
}

export function shouldUngroupBrowserControlTab(options: {
  readonly groupTitle: string | undefined
  readonly isDebuggerAttached: boolean
}): boolean {
  return isBrowserControlGroupTitle(options.groupTitle) && !options.isDebuggerAttached
}
