import type { Page } from "playwright-core"

const installed = new WeakSet<object>()

/** Title is read-only, but Playwright exposes no timeout for its context wait. */
export function installPageReadTimeout(page: Pick<Page, "title">, timeoutMs = 5_000): void {
  if (installed.has(page)) return
  installed.add(page)
  const title = page.title.bind(page)
  page.title = () => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`page.title() timed out after ${timeoutMs}ms waiting for the page execution context`)), timeoutMs)
    Promise.resolve().then(title).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}
