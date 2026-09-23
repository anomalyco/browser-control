import type { Page } from "playwright-core"

const installed = new WeakSet<object>()

/** A bounded read did not settle; this does not establish renderer unresponsiveness. */
export class PageReadTimeoutError extends Error {
  readonly operation = "page.title"

  constructor(readonly timeoutMs: number) {
    super(`page.title() timed out after ${timeoutMs}ms: the page execution-context read did not complete; the context may be unavailable or busy.`)
    this.name = "PageReadTimeoutError"
  }
}

/** Title is read-only, but Playwright exposes no timeout for its context wait. */
export function installPageReadTimeout(page: Pick<Page, "title">, timeoutMs = 5_000): void {
  if (installed.has(page)) return
  installed.add(page)
  const title = page.title.bind(page)
  page.title = () => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PageReadTimeoutError(timeoutMs)), timeoutMs)
    Promise.resolve().then(title).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}
