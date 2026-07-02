/**
 * Per-client CDP target visibility.
 *
 * Each Browser Control session's sandbox connects as its own CDP client and
 * identifies itself with a Browser Control session id. Tabs created for a
 * session are owned by that session. Without scoping, every client is told
 * about every tab, so concurrently connected clients attach to and
 * double-initialize each other's pages, which makes
 * `newPage`/`setContent`/`evaluate` hang non-deterministically.
 *
 * Visibility rule:
 * - Session-owned targets are visible only to that session's clients.
 * - Everything else (user toolbar-attached tabs and tabs created by raw
 *   `connectOverCDP` clients) stays visible to every client, so raw-client
 *   reconnects and `--target-url` recovery keep working.
 *
 * Two simultaneous raw clients can still interfere with each other's tabs;
 * Browser Control sessions are the isolated, supported path.
 */
export function canClientSeeTarget(options: {
  readonly clientSessionId: string | undefined
  readonly targetOwnerSessionId: string | undefined
}): boolean {
  if (options.targetOwnerSessionId === undefined) {
    return true
  }
  return options.clientSessionId === options.targetOwnerSessionId
}
