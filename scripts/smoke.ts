#!/usr/bin/env tsx
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Clock, Console, Effect, Fiber, Option } from "effect"
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright-core"
import { WebSocket } from "ws"
import cp from "node:child_process"
import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import util from "node:util"

const endpointUrl = process.env.BROWSER_CONTROL_ENDPOINT ?? "http://127.0.0.1:19989"
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const localCliPath = path.join(repoRoot, "src", "cli.ts")
const browserControlTimeoutMs = parsePositiveInteger(process.env.SMOKE_BROWSER_CONTROL_TIMEOUT_MS) ?? 90_000
const repeatCount = parsePositiveInteger(process.env.SMOKE_REPEAT) ?? 1
const selectedCaseNames = parseCaseFilter(process.env.SMOKE_CASE)

type ExtensionStatus = {
  readonly connected: boolean
  readonly version: string | null
  readonly activeTargets: number
  readonly childTargets: number
  readonly cdpClients: number
  readonly sessionIds: readonly string[]
}

type SmokeCase = {
  readonly name: string
  readonly expectedFailure?: boolean
  readonly run: (page: Page) => Effect.Effect<unknown, Error>
}

type RecordingMetadata = {
  readonly mode: string
  readonly artifactType: string
  readonly sessionId: string
  readonly frameCount: number
}

type OwnerCdpPage = {
  readonly closeTarget: () => Effect.Effect<void, Error>
  readonly evaluate: <A = unknown>(expression: string) => Effect.Effect<A, Error>
  readonly navigate: (url: string) => Effect.Effect<void, Error>
  readonly waitFor: (expression: string) => Effect.Effect<void, Error>
  readonly close: () => Promise<void>
}

type CaseRunResult = {
  readonly name: string
  readonly iteration: number
  readonly status: "pass" | "fail" | "expected-fail" | "unexpected-pass"
  readonly durationMs: number
  readonly beforeStatus: ExtensionStatus
  readonly afterStatus: ExtensionStatus
  readonly value?: unknown
  readonly error?: string
}

const runLocalCartFlow = Effect.fnUntraced(function* (page: Page) {
  yield* playwright("set cart fixture", () =>
    page.setContent(`
      <!doctype html>
      <html>
        <head><title>Cart Fixture</title></head>
        <body>
          <main id="product">
            <h1 class="name">Samsung galaxy s6</h1>
            <a href="#" id="add-to-cart">Add to cart</a>
            <a href="#cart" id="cartur">Cart</a>
          </main>
          <main id="cart" hidden>
            <table><tbody id="tbodyid"></tbody></table>
          </main>
          <script>
            const productName = document.querySelector('.name').textContent
            document.querySelector('#add-to-cart').addEventListener('click', (event) => {
              event.preventDefault()
              window.cartProduct = productName
            })
            document.querySelector('#cartur').addEventListener('click', (event) => {
              event.preventDefault()
              document.querySelector('#product').hidden = true
              document.querySelector('#cart').hidden = false
              document.querySelector('#tbodyid').innerHTML = '<tr><td>' + window.cartProduct + '</td></tr>'
            })
          </script>
        </body>
      </html>
    `),
  )
  yield* playwright("wait product page", () => page.locator(".name").waitFor({ timeout: 10_000 }))
  const productName = yield* textContent(page.locator(".name"), "product name")
  yield* click(page.getByRole("link", { name: "Add to cart" }), "add to cart")
  yield* click(page.locator("#cartur"), "cart link")
  yield* playwright("wait cart row", () => page.locator("#tbodyid tr").first().waitFor({ timeout: 10_000 }))
  return {
    productName,
    cartText: yield* textContent(page.locator("#tbodyid"), "cart contents"),
  }
})

const runLocalCheckoutFlow = Effect.fnUntraced(function* (page: Page) {
  yield* playwright("set checkout fixture", () =>
    page.setContent(`
      <!doctype html>
      <html>
        <head><title>Swag Labs Fixture</title></head>
        <body>
          <main id="login">
            <h1>Swag Labs</h1>
            <input id="user-name" placeholder="Username" />
            <input id="password" placeholder="Password" type="password" />
            <button id="login-button">Login</button>
          </main>
          <main id="products" hidden>
            <h1>Products</h1>
            <button>Add to cart</button>
            <a class="shopping_cart_link" href="#cart">Cart</a>
          </main>
          <main id="cart" hidden>
            <h1>Your Cart</h1>
            <button>Checkout</button>
          </main>
          <main id="checkout" hidden>
            <input id="first-name" />
            <input id="last-name" />
            <input id="postal-code" />
            <button id="continue">Continue</button>
            <button id="finish" hidden>Finish</button>
          </main>
          <main id="complete" hidden>
            <h2 class="complete-header">Thank you for your order!</h2>
          </main>
          <script>
            const show = (id) => {
              document.querySelectorAll('main').forEach((element) => {
                element.hidden = element.id !== id
              })
            }
            document.querySelector('#login-button').addEventListener('click', () => show('products'))
            document.querySelector('.shopping_cart_link').addEventListener('click', (event) => {
              event.preventDefault()
              show('cart')
            })
            document.querySelector('#cart button').addEventListener('click', () => show('checkout'))
            document.querySelector('#continue').addEventListener('click', () => {
              document.querySelector('#finish').hidden = false
            })
            document.querySelector('#finish').addEventListener('click', () => show('complete'))
          </script>
        </body>
      </html>
    `),
  )
  yield* fillInput(page.getByPlaceholder("Username"), "standard_user", "sauce username")
  yield* fillInput(page.getByPlaceholder("Password"), "secret_sauce", "sauce password")
  yield* click(page.getByRole("button", { name: "Login" }), "sauce login")
  yield* playwright("wait products", () => page.getByText("Products").waitFor({ timeout: 10_000 }))
  yield* click(page.getByRole("button", { name: "Add to cart" }).first(), "sauce add first item")
  yield* click(page.locator(".shopping_cart_link"), "sauce cart")
  yield* click(page.getByRole("button", { name: "Checkout" }), "sauce checkout")
  yield* playwright("wait sauce checkout", () => page.locator("#continue").waitFor({ timeout: 10_000 }))
  yield* fillInputs(
    page,
    [
      { selector: "#first-name", value: "Kit" },
      { selector: "#last-name", value: "BrowserControl" },
      { selector: "#postal-code", value: "12345" },
    ],
    "sauce checkout fields",
  )
  yield* clickSelector(page, "#continue", "sauce continue")
  yield* clickSelector(page, "#finish", "sauce finish")
  return { complete: yield* textContent(page.locator(".complete-header"), "sauce complete") }
})

const cases: SmokeCase[] = [
  {
    name: "local-actions",
    run: Effect.fnUntraced(function* (page) {
      const results: unknown[] = []
      yield* playwright("set dynamic id fixture", () => page.setContent(`<button>Button with Dynamic ID</button>`))
      yield* click(page.getByRole("button", { name: "Button with Dynamic ID" }), "dynamic id button")
      results.push({ challenge: "dynamic-id" })

      yield* playwright("set ajax fixture", () =>
        page.setContent(`<button>Button Triggering AJAX Request</button><p class="bg-success"></p><script>document.querySelector('button').addEventListener('click', () => { document.querySelector('.bg-success').textContent = 'Data loaded with AJAX get request.' })</script>`),
      )
      yield* click(page.getByRole("button", { name: "Button Triggering AJAX Request" }), "ajax button")
      results.push({ challenge: "ajax", message: yield* textContent(page.locator(".bg-success"), "ajax success", 20_000) })

      yield* playwright("set physical click fixture", () =>
        page.setContent(`<button class="btn">Button That Ignores DOM Click Event</button><script>document.querySelector('button').addEventListener('click', (event) => event.currentTarget.className = 'btn btn-success')</script>`),
      )
      const physicalClickButton = page.getByRole("button", { name: "Button That Ignores DOM Click Event" })
      yield* click(physicalClickButton, "physical click button")
      results.push({ challenge: "physical-click", className: yield* attribute(physicalClickButton, "class", "physical click class") })

      yield* playwright("set client delay fixture", () =>
        page.setContent(`<button>Button Triggering Client Side Logic</button><p class="bg-success"></p><script>document.querySelector('button').addEventListener('click', () => { document.querySelector('.bg-success').textContent = 'Data calculated on the client side.' })</script>`),
      )
      yield* click(page.getByRole("button", { name: "Button Triggering Client Side Logic" }), "client delay button")
      results.push({ challenge: "client-delay", message: yield* textContent(page.locator(".bg-success"), "client delay success", 20_000) })

      yield* playwright("set progress fixture", () =>
        page.setContent(`<button>Start</button><button>Stop</button><div id="progressBar" role="progressbar" aria-valuenow="0"></div><script>document.querySelector('button').addEventListener('click', () => { document.querySelector('#progressBar').setAttribute('aria-valuenow', '50') })</script>`),
      )
      yield* click(page.getByRole("button", { name: "Start" }), "progress start")
      yield* playwright("wait for progress >= 75", () =>
        page.waitForFunction(() => {
          const progressBar = document.querySelector("#progressBar")
          return progressBar && Number(progressBar.getAttribute("aria-valuenow")) >= 50
        }, null, { timeout: 30_000 }),
      )
      yield* click(page.getByRole("button", { name: "Stop" }), "progress stop")
      results.push({ challenge: "progress-bar", value: yield* attribute(page.locator("#progressBar"), "aria-valuenow", "progress value") })
      return results
    }),
  },
  {
    name: "local-forms",
    run: Effect.fnUntraced(function* (page) {
      const results: unknown[] = []

      yield* playwright("set text input fixture", () =>
        page.setContent(`<input aria-label="text input" /><button id="updatingButton">Button That Should Change</button><script>document.querySelector('button').addEventListener('click', () => { document.querySelector('button').textContent = document.querySelector('input').value })</script>`),
      )
      yield* fill(page.getByRole("textbox"), "Browser Control wins", "text input")
      yield* click(page.getByRole("button", { name: "Button That Should Change" }), "rename button")
      results.push({ challenge: "text-input", buttonName: yield* textContent(page.locator("#updatingButton"), "renamed button") })

      yield* playwright("set sample app fixture", () =>
        page.setContent(`<input name="UserName" placeholder="User Name" /><input name="Password" placeholder="********" type="password" /><button>Log In</button><p id="loginstatus"></p><script>document.querySelector('button').addEventListener('click', () => { document.querySelector('#loginstatus').textContent = 'Welcome, ' + document.querySelector('[name=UserName]').value + '!' })</script>`),
      )
      yield* fillInput(page.getByPlaceholder("User Name"), "kit", "sample username")
      yield* fillInput(page.getByPlaceholder("********"), "pwd", "sample password")
      yield* click(page.getByRole("button", { name: "Log In" }), "sample login")
      results.push({ challenge: "sample-login", status: yield* textContent(page.locator("#loginstatus"), "sample login status") })

      yield* playwright("set scrollbars fixture", () => page.setContent(`<div style="width: 200px; height: 100px; overflow: auto"><div style="width: 1000px; height: 500px; display: flex; align-items: end; justify-content: end"><button>Hiding Button</button></div></div>`))
      const hiddenButton = page.getByRole("button", { name: "Hiding Button" })
      yield* playwright("scroll hidden button", () => hiddenButton.scrollIntoViewIfNeeded())
      yield* click(hiddenButton, "hidden button")
      results.push({ challenge: "scrollbars" })

      yield* playwright("set shadow fixture", () =>
        page.setContent(`<button id="buttonGenerate">Generate</button><input id="editField" /><script>document.querySelector('#buttonGenerate').addEventListener('click', () => { document.querySelector('#editField').value = 'fixture-shadow-value' })</script>`),
      )
      yield* click(page.locator("#buttonGenerate"), "shadow generate")
      results.push({ challenge: "shadow-dom", generated: yield* inputValue(page.locator("#editField"), "shadow generated value") })
      return results
    }),
  },
  {
    name: "sampleapp-fill-diagnostic",
    run: Effect.fnUntraced(function* (page) {
      yield* playwright("set sample diagnostic fixture", () =>
        page.setContent(`<input name="UserName" placeholder="User Name" /><input name="Password" placeholder="********" type="password" />`),
      )
      yield* fill(page.getByPlaceholder("User Name"), "kit", "sample username")
      const passwordFill = yield* Effect.matchEffect(fill(page.getByPlaceholder("********"), "pwd", "sample password"), {
        onFailure: (error) => Effect.succeed({ _tag: "Failure" as const, error }),
        onSuccess: () => Effect.succeed({ _tag: "Success" as const }),
      })
      const diagnostics = yield* playwright("sample app diagnostics", () =>
        page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll("input")).map((input) => {
            const rect = input.getBoundingClientRect()
            const style = getComputedStyle(input)
            return {
              name: input.name,
              type: input.type,
              placeholder: input.placeholder,
              value: input.value,
              disabled: input.disabled,
              readOnly: input.readOnly,
              connected: input.isConnected,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              display: style.display,
              visibility: style.visibility,
              pointerEvents: style.pointerEvents,
            }
          })
          return {
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            visibilityState: document.visibilityState,
            hasFocus: document.hasFocus(),
            activeElement: document.activeElement?.tagName,
            inputs,
          }
        }),
      )
      if (passwordFill._tag === "Failure") {
        return yield* Effect.fail(new Error(`sample password diagnostic ${formatValue(diagnostics)}`, { cause: passwordFill.error }))
      }
      return diagnostics
    }),
  },
  {
    name: "local-cart",
    run: runLocalCartFlow,
  },
  {
    name: "local-checkout",
    run: runLocalCheckoutFlow,
  },
  {
    // Regression for issue #7: a pre-existing Browser Control session sandbox
    // must not attach to a second raw CDP client's pages. If it does, the cart
    // page can appear to work but checkout's first locator.evaluate wedges.
    name: "stale-client-checkout",
    run: Effect.fnUntraced(function* (page) {
      const marker = `bc-stale-${Date.now()}`
      const staleSession = `${marker}-session`
      yield* boundedCleanup("close wrapper stale-client page", () => page.close())
      yield* closeOwningBrowser(page, "close wrapper client before stale-client checkout")
      return yield* Effect.gen(function* () {
        yield* runBrowserControl(["session", "new", staleSession])
        const output = yield* runBrowserControl(["execute", "--session", staleSession, "return page.url()"])
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const browser = yield* scopedBrowser()
            const context = yield* playwright("get stale checkout browser context", () => getBrowserContext(browser))
            const checkoutPage = yield* playwright("create stale checkout page", () => context.newPage())
            return yield* Effect.gen(function* () {
              const cart = yield* runLocalCartFlow(checkoutPage)
              const checkout = yield* runLocalCheckoutFlow(checkoutPage)
              return { staleSession, output: output.trim(), cart, checkout }
            }).pipe(Effect.ensuring(boundedCleanup("close stale checkout page", () => checkoutPage.close())))
          }),
        )
      }).pipe(Effect.ensuring(runBrowserControl(["session", "delete", staleSession]).pipe(Effect.ignore)))
    }),
  },
  {
    // Reviewer regression: a raw client page can be announced to a session
    // client before that session owns a target. When the session later creates
    // its sandbox page, the relay must detach/prune the raw target from that
    // session so the raw client's evaluate path stays healthy.
    name: "raw-first-checkout",
    run: Effect.fnUntraced(function* (page) {
      const marker = `bc-raw-first-${Date.now()}`
      const session = `${marker}-session`
      yield* playwright("set raw-first marker", () => page.setContent(`<title>${marker}</title><input placeholder="raw marker" />`))
      return yield* Effect.gen(function* () {
        yield* runBrowserControl(["session", "new", session])
        const output = yield* runBrowserControl(["execute", "--session", session, "return page.url()"])
        const cart = yield* runLocalCartFlow(page)
        const checkout = yield* runLocalCheckoutFlow(page)
        return { session, output: output.trim(), cart, checkout }
      }).pipe(Effect.ensuring(runBrowserControl(["session", "delete", session]).pipe(Effect.ignore)))
    }),
  },
  {
    name: "reconnect-evaluate",
    run: Effect.fnUntraced(function* (page) {
      const marker = `bc-reconnect-${Date.now()}`
      yield* goto(page, "about:blank")
      yield* playwright("set reconnect content", () => page.setContent(`<title>${marker}</title><main id="marker">${marker}</main>`))
      yield* closeOwningBrowser(page, "close first reconnect client")
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const secondBrowser = yield* scopedBrowser()
          const secondContext = yield* playwright("get second browser context", () => getBrowserContext(secondBrowser))
          const replayedPage = yield* findPageByTitle({ context: secondContext, title: marker })
          if (!replayedPage) {
            return yield* Effect.fail(new Error(`replayed page not found for ${marker}`))
          }
          const text = yield* playwright("evaluate replayed page", () => replayedPage.locator("#marker").textContent({ timeout: 10_000 }))
          yield* boundedCleanup("close replayed reconnect page", () => replayedPage.close())
          return text
        }),
      )
    }),
  },
  {
    name: "redirect-reconnect-evaluate",
    run: Effect.fnUntraced(function* (page) {
      const marker = `bc-redirect-${Date.now()}`
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* scopedRedirectFixture(marker)
          yield* goto(page, fixture.startUrl)
          const beforeReconnect = yield* playwright("evaluate redirected page", () =>
            page.evaluate(() => ({ href: location.href, marker: document.querySelector("#marker")?.textContent })),
          )
          if (beforeReconnect.href !== fixture.finalUrl || beforeReconnect.marker !== marker) {
            return yield* Effect.fail(new Error(`redirect fixture did not reach final document: ${formatValue(beforeReconnect)}`))
          }

          yield* closeOwningBrowser(page, "close first redirect client")
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const secondBrowser = yield* scopedBrowser()
              const secondContext = yield* playwright("get redirect replay context", () => getBrowserContext(secondBrowser))
              const replayedPage = yield* findPageByTitle({ context: secondContext, title: marker })
              if (!replayedPage) {
                return yield* Effect.fail(new Error(`redirect replayed page not found for ${marker}`))
              }
              const afterReconnect = yield* playwright("evaluate redirected page after reconnect", () =>
                replayedPage.evaluate(() => ({ href: location.href, marker: document.querySelector("#marker")?.textContent })),
              )
              yield* boundedCleanup("close redirect replay page", () => replayedPage.close())
              if (afterReconnect.href !== fixture.finalUrl || afterReconnect.marker !== marker) {
                return yield* Effect.fail(new Error(`evaluate after redirect reconnect returned the wrong document: ${formatValue(afterReconnect)}`))
              }
              return { beforeReconnect, afterReconnect }
            }),
          )
        }),
      )
    }),
  },
  {
    name: "oopif-reconnect",
    run: Effect.fnUntraced(function* (page) {
      const marker = `bc-oopif-${Date.now()}`
      const html = `<title>${marker}</title><h1>${marker}</h1><iframe src="https://example.com/"></iframe>`
      yield* goto(page, "about:blank")
      yield* playwright("set oopif content", () => page.setContent(html))
      yield* playwright("wait oopif frame", () =>
        page.waitForFunction(() => {
          return window.frames.length === 1
        }, null, { timeout: 10_000 }),
      )
      yield* closeOwningBrowser(page, "close first oopif client")
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const secondBrowser = yield* scopedBrowser()
          const secondContext = yield* playwright("get oopif replay context", () => getBrowserContext(secondBrowser))
          const replayedPage = yield* findPageByTitle({ context: secondContext, title: marker })
          if (!replayedPage) {
            return yield* Effect.fail(new Error(`oopif replayed page not found for ${marker}`))
          }
          const exampleFrame = yield* waitForFrameUrl({ page: replayedPage, urlIncludes: "example.com" })
          if (!exampleFrame) {
            yield* boundedCleanup("close failed oopif replay page", () => replayedPage.close())
            return yield* Effect.fail(new Error("example.com iframe not replayed"))
          }
          const text = yield* playwright("read oopif frame", () => exampleFrame.locator("h1").textContent({ timeout: 10_000 }))
          yield* boundedCleanup("close replayed oopif page", () => replayedPage.close())
          return text
        }),
      )
    }),
  },
  {
    name: "execute-target-url",
    run: Effect.fnUntraced(function* (page) {
      const firstMarker = `bc-target-a-${Date.now()}`
      const secondMarker = `bc-target-b-${Date.now()}`
      const smokeSession = `${secondMarker}-session`
      const extraPage = yield* playwright("create target selection page", () => page.context().newPage())
      return yield* Effect.gen(function* () {
        yield* goto(page, `https://example.com/?${firstMarker}`)
        yield* goto(extraPage, `https://example.com/?${secondMarker}`)
        yield* runBrowserControl(["session", "new", smokeSession])
        const output = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          "--target-url",
          secondMarker,
          "const result = { url: page.url(), title: await page.title() }; await page.close(); return result",
        ])
        if (!output.includes(secondMarker)) {
          return yield* Effect.fail(new Error(`target-url did not select ${secondMarker}: ${output}`))
        }
        return output.trim()
      }).pipe(
        Effect.ensuring(
          Effect.all([
            boundedCleanup("close target selection page", () => extraPage.close()),
            runBrowserControl(["session", "delete", smokeSession]).pipe(Effect.ignore),
          ]).pipe(Effect.ignore),
        ),
      )
    }),
  },
  {
    name: "execute-page-recovery",
    run: Effect.fnUntraced(function* () {
      const smokeSession = `bc-recovery-${Date.now()}`
      return yield* Effect.gen(function* () {
        yield* runBrowserControl(["session", "new", smokeSession])
        yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          "await page.setContent('<title>Recovery fixture</title>'); return await page.title()",
        ])
        const crashStartedAt = yield* Clock.currentTimeMillis
        const crashResult = yield* Effect.result(runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          "const cdp = await context.newCDPSession(page); await cdp.send('Page.crash'); return 'unexpected'",
        ]))
        const crashDurationMs = (yield* Clock.currentTimeMillis) - crashStartedAt
        if (crashResult._tag !== "Failure" || !crashResult.failure.message.toLowerCase().includes("target crashed")) {
          return yield* Effect.fail(new Error(`crash execute did not report the target crash: ${formatValue(crashResult)}`))
        }
        if (crashDurationMs > 10_000) {
          return yield* Effect.fail(new Error(`crash execute took ${crashDurationMs}ms instead of failing promptly`))
        }
        const statusOutput = yield* runBrowserControl(["status"])
        if (!statusOutput.includes("crashed=true")) {
          return yield* Effect.fail(new Error(`status did not expose the crashed target: ${statusOutput}`))
        }
        const output = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          "return { url: page.url(), title: await page.title() }",
        ])
        if (!output.includes("session default page") || !output.includes("about:blank")) {
          return yield* Effect.fail(new Error(`execute did not recover the crashed session page: ${output}`))
        }
        return output.trim()
      }).pipe(Effect.ensuring(runBrowserControl(["session", "delete", smokeSession]).pipe(Effect.ignore)))
    }),
  },
  {
    name: "execute-page-detach-recovery",
    run: Effect.fnUntraced(function* () {
      const smokeSession = `bc-detach-recovery-${Date.now()}`
      return yield* Effect.gen(function* () {
        yield* runBrowserControl(["session", "new", smokeSession])
        const closeOutput = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          "await page.setContent('<title>Detach recovery fixture</title>'); await page.close(); return 'closed'",
        ])
        if (!closeOutput.includes("session default page was closed")) {
          return yield* Effect.fail(new Error(`closing the session root did not report stale page state: ${closeOutput}`))
        }
        const output = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          "return { url: page.url(), title: await page.title() }",
        ])
        if (!output.includes("about:blank")) {
          return yield* Effect.fail(new Error(`execute retained the detached session page: ${output}`))
        }
        return output.trim()
      }).pipe(Effect.ensuring(runBrowserControl(["session", "delete", smokeSession]).pipe(Effect.ignore)))
    }),
  },
  {
    name: "execute-fill-helpers",
    run: Effect.fnUntraced(function* () {
      const marker = `bc-fill-${Date.now()}`
      const smokeSession = `${marker}-session`
      return yield* Effect.gen(function* () {
        yield* runBrowserControl(["session", "new", smokeSession])
        const output = yield* runBrowserControl(
          [
            "execute",
            "--session",
            smokeSession,
            `
await page.setContent('<input id="one" placeholder="One"><input id="two"><textarea id="three"></textarea>')
await fillInput('#one', 'alpha')
await fillInputs(page, [
  { selector: page.getByRole('textbox').nth(1), value: 'beta' },
  { selector: '#three', value: 'gamma' },
])
const values = await page.evaluate(() => ({
  one: document.querySelector('#one')?.value,
  two: document.querySelector('#two')?.value,
  three: document.querySelector('#three')?.value,
}))
return values
          `,
          ],
          { retryOnTimeout: true },
        )
        if (!output.includes("alpha") || !output.includes("beta") || !output.includes("gamma")) {
          return yield* Effect.fail(new Error(`execute fill helpers did not fill fields: ${output}`))
        }
        return output.trim()
      }).pipe(Effect.ensuring(runBrowserControl(["session", "delete", smokeSession]).pipe(Effect.ignore)))
    }),
  },
  {
    name: "execute-snapshot-refs",
    run: Effect.fnUntraced(function* () {
      const marker = `bc-snapshot-${Date.now()}`
      const smokeSession = `${marker}-session`
      return yield* Effect.gen(function* () {
        yield* runBrowserControl(["session", "new", smokeSession])
        const snapshotOutput = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          `
await page.setContent(\`
  <main hidden><button>Hidden template action</button></main>
  <main>
    <nav aria-label="Fixture navigation"><a href="#elsewhere">Elsewhere</a></nav>
    <h1>Snapshot fixture</h1>
    <p>Important fixture notice.</p>
    <button id="hidden-child">Visible action<span hidden>hidden-value-must-not-leak</span><span aria-hidden="true">aria-hidden-value-must-not-leak</span></button>
    <label for="private">Private field</label>
    <input id="private" value="private-value-must-not-leak">
    <label for="choice">Choice</label>
    <select id="choice"><option>Alpha</option><option selected>Beta</option></select>
    <button id="duplicate">First duplicate</button>
    <button id="duplicate">Second duplicate</button>
    <button id="continue">Continue</button>
    <p id="duplicate-result"></p>
    <p id="result" hidden>Continued</p>
    <script>
      const duplicates = document.querySelectorAll('#duplicate')
      duplicates[0].addEventListener('click', () => { document.querySelector('#duplicate-result').textContent = 'first' })
      duplicates[1].addEventListener('click', () => { document.querySelector('#duplicate-result').textContent = 'second' })
      document.querySelector('#continue').addEventListener('click', () => { document.querySelector('#result').hidden = false })
    </script>
  </main>
\`)
return await snapshot()
          `,
        ])
        if (
          !snapshotOutput.includes('navigation "Fixture navigation" [1 controls]') ||
          !snapshotOutput.includes('p "Important fixture notice."') ||
          !snapshotOutput.includes('button "Visible action" [ref=e1]') ||
          snapshotOutput.includes("hidden-value-must-not-leak") ||
          snapshotOutput.includes("aria-hidden-value-must-not-leak") ||
          !snapshotOutput.includes('textbox "Private field" [ref=e2]') ||
          snapshotOutput.includes("private-value-must-not-leak") ||
          snapshotOutput.includes("Hidden template action") ||
          !snapshotOutput.includes('combobox "Choice" [ref=e3 selected="Beta" 2 options]') ||
          !snapshotOutput.includes('button "First duplicate" [ref=e4]') ||
          !snapshotOutput.includes('button "Second duplicate" [ref=e5]') ||
          !snapshotOutput.includes('button "Continue" [ref=e6]')
        ) {
          return yield* Effect.fail(new Error(`compact snapshot output was incomplete: ${snapshotOutput}`))
        }
        const diffOutput = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          `
await page.evaluate(() => {
  const privateInput = document.querySelector('#private')
  if (privateInput instanceof HTMLInputElement) privateInput.value = 'private-value-after-diff-must-not-leak'
  const status = document.createElement('div')
  status.id = 'saved-status'
  status.setAttribute('role', 'status')
  status.textContent = 'Saved fixture'
  const undo = document.createElement('button')
  undo.id = 'undo'
  undo.textContent = 'Undo fixture'
  document.querySelector('main:not([hidden])')?.append(status, undo)
})
return await snapshot({ diff: true })
          `,
        ])
        if (
          !diffOutput.includes('status "Saved fixture"') ||
          !diffOutput.includes('button "Undo fixture" [ref=e7]') ||
          diffOutput.includes("private-value-after-diff-must-not-leak") ||
          !diffOutput.includes("2 additions, 0 removals")
        ) {
          return yield* Effect.fail(new Error(`snapshot diff did not isolate additions: ${diffOutput}`))
        }
        const diffRefOutput = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          `
let previousRefError
try { ref('e1') } catch (error) { previousRefError = error instanceof Error ? error.message : String(error) }
const addedRefCount = await ref('e7').count()
await page.evaluate(() => {
  document.querySelector('#saved-status')?.remove()
  document.querySelector('#undo')?.remove()
})
const restored = await snapshot()
return { previousRefError, addedRefCount, restored }
          `,
        ])
        if (
          !diffRefOutput.includes("Unknown snapshot ref: e1") ||
          !diffRefOutput.includes("addedRefCount: 1") ||
          !diffRefOutput.includes('button "Continue" [ref=e6]')
        ) {
          return yield* Effect.fail(new Error(`snapshot diff refs were unsafe or unusable: ${diffRefOutput}`))
        }
        const duplicateOutput = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          `await ref('e5').click(); return { duplicate: await page.locator('#duplicate-result').textContent() }`,
        ])
        if (!duplicateOutput.includes("duplicate: 'second'")) {
          return yield* Effect.fail(new Error(`duplicate-id snapshot ref resolved incorrectly: ${duplicateOutput}`))
        }
        const driftOutput = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          `
await page.evaluate(() => {
  const duplicate = document.querySelectorAll('#duplicate')[1]
  const inserted = document.createElement('button')
  inserted.id = 'inserted-before-duplicate'
  inserted.textContent = 'Inserted sibling'
  duplicate?.before(inserted)
})
const driftedCount = await ref('e5').count()
await page.evaluate(() => document.querySelector('#inserted-before-duplicate')?.remove())
return { driftedCount }
          `,
        ])
        if (!driftOutput.includes("driftedCount: 0")) {
          return yield* Effect.fail(new Error(`snapshot ref did not fail closed after DOM drift: ${driftOutput}`))
        }
        const scopedOutput = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          `return await snapshot({ within: '#continue' })`,
        ])
        if (!scopedOutput.includes('button "Continue" [ref=e1]')) {
          return yield* Effect.fail(new Error(`snapshot omitted the within root: ${scopedOutput}`))
        }
        const actionOutput = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          `await ref('e1').click(); return { continued: await page.locator('#result').isVisible() }`,
        ])
        if (!actionOutput.includes("continued: true")) {
          return yield* Effect.fail(new Error(`snapshot ref did not resolve across execute calls: ${actionOutput}`))
        }
        const denseOutput = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          `
const cards = Array.from({ length: 30 }, (_, index) => {
  const number = index + 1
  return '<li><a href="#story-' + number + '">Story ' + number + ' primary destination</a><a href="#author-' + number + '">author' + number + '</a><button>Save story ' + number + '</button><p>Summary ' + number + '</p></li>'
}).join('')
await page.setContent('<main><h1>Dense feed</h1><ul>' + cards + '</ul></main>')
return await snapshot()
          `,
        ])
        if (!denseOutput.includes('link "Story 30 primary destination"') || denseOutput.includes('link "author30"')) {
          return yield* Effect.fail(new Error(`snapshot budget did not prioritize primary items across the dense feed: ${denseOutput}`))
        }
        const structureOutput = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          `
const inlineCode = Array.from({ length: 100 }, (_, index) => '<code>inline-' + index + '</code>').join('')
await page.setContent(
  '<main><h1>Semantic fixture</h1>' +
  '<div role="alert">Review before continuing</div><div role="status">Draft ready</div>' +
  '<fieldset><legend>Sign-in policy</legend><label>Secret<textarea>must-not-leak</textarea></label><input type="checkbox" checked aria-label="Require MFA"></fieldset>' +
  '<div role="tablist" aria-label="Settings sections"><button role="tab" aria-selected="true">Security</button><button role="tab" aria-selected="false">Billing</button></div>' +
  '<details open><summary>Recovery settings</summary><p>Recovery detail</p></details>' +
  inlineCode +
  '<table><caption>Team access</caption><tr><th scope="col">Member</th><th scope="col">Role</th></tr><tr><th scope="row">Ada</th><td>Owner</td></tr></table>' +
  '<pre><code>const safe = true</code></pre>' +
  '<input name="q">' +
  '<dialog open aria-modal="true" aria-label="Confirmation"><button>Cancel</button></dialog></main>'
)
return await snapshot({ interactive: true })
          `,
        ])
        if (
          !structureOutput.includes('alert "Review before continuing"') ||
          !structureOutput.includes('status "Draft ready"') ||
          !structureOutput.includes('group "Sign-in policy" [2 controls]') ||
          !structureOutput.includes('tablist "Settings sections"') ||
          !structureOutput.includes('tab "Security"') ||
          !structureOutput.includes('selected=true') ||
          !structureOutput.includes('group "Recovery settings" [expanded=true]') ||
          !structureOutput.includes('table "Team access" [2 rows]') ||
          !structureOutput.includes('row "Member | Role"') ||
          !structureOutput.includes('row "Member: Ada | Role: Owner"') ||
          !structureOutput.includes('code "const safe = true"') ||
          !structureOutput.includes('textbox "q"') ||
          !structureOutput.includes('dialog "Confirmation" [open=true modal=true]') ||
          structureOutput.includes('inline-99') ||
          structureOutput.includes('must-not-leak')
        ) {
          return yield* Effect.fail(new Error(`snapshot omitted semantic structure or leaked a form value: ${structureOutput}`))
        }
        const unnamedRefOutput = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          `const captured = await snapshot({ within: 'input[name="q"]' }); return { captured, count: await ref('e1').count() }`,
        ])
        if (!unnamedRefOutput.includes('textbox "q"') || !unnamedRefOutput.includes("count: 1")) {
          return yield* Effect.fail(new Error(`snapshot ref for an unnamed control did not preserve structural identity: ${unnamedRefOutput}`))
        }
        return {
          snapshotOutput: snapshotOutput.trim(),
          diffOutput: diffOutput.trim(),
          diffRefOutput: diffRefOutput.trim(),
          duplicateOutput: duplicateOutput.trim(),
          driftOutput: driftOutput.trim(),
          scopedOutput: scopedOutput.trim(),
          actionOutput: actionOutput.trim(),
          denseOutput: denseOutput.trim(),
          structureOutput: structureOutput.trim(),
          unnamedRefOutput: unnamedRefOutput.trim(),
        }
      }).pipe(Effect.ensuring(runBrowserControl(["session", "delete", smokeSession]).pipe(Effect.ignore)))
    }),
  },
  {
    name: "handoff-navigation",
    run: Effect.fnUntraced(function* (page) {
      const extension = yield* fetchStatus()
      if (extension.version !== "0.0.17") {
        return yield* Effect.fail(new Error(`handoff-navigation requires the built 0.0.17 shim; connected extension is ${extension.version ?? "unknown"}`))
      }
      const marker = `bc-handoff-${Date.now()}`
      const smokeSession = `${marker}-session`
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* scopedHandoffFixture(marker)
          yield* goto(page, fixture.beforeUrl)
          yield* runBrowserControl(["session", "new", smokeSession])
          yield* runBrowserControl(["session", "adopt", "--session", smokeSession, "--target-url", marker])

          const executeFiber = yield* runBrowserControl([
            "execute",
            "--session",
            smokeSession,
            `await handoff('Navigate and resume ${marker}', { timeoutMs: 30000 }); return { resumed: true, url: page.url() }`,
          ]).pipe(Effect.forkChild)
          yield* Effect.sleep("500 millis")
          const ownerPage = yield* scopedOwnerCdpPage({ sessionId: smokeSession, urlIncludes: marker })

          yield* ownerPage.waitFor(`document.querySelector('#__browser_control_page_status__')?.shadowRoot?.querySelector('button') != null`)
          yield* ownerPage.navigate(fixture.afterUrl)
          yield* ownerPage.waitFor(`document.querySelector('#__browser_control_page_status__')?.shadowRoot?.querySelector('button') != null`)
          yield* ownerPage.evaluate(`document.querySelector('#decoy')?.click()`)

          const premature = yield* Fiber.join(executeFiber).pipe(Effect.timeoutOption("200 millis"))
          if (Option.isSome(premature)) {
            return yield* Effect.fail(new Error(`handoff resumed from a non-matching page control: ${premature.value}`))
          }

          yield* ownerPage.evaluate(`document.querySelector('#__browser_control_page_status__')?.shadowRoot?.querySelector('button')?.click()`)
          const output = yield* Fiber.join(executeFiber)
          if (!output.includes("resumed: true") || !output.includes(fixture.afterUrl)) {
            return yield* Effect.fail(new Error(`handoff did not resume on the navigated page: ${output}`))
          }
          return output.trim()
        }).pipe(Effect.ensuring(runBrowserControl(["session", "delete", smokeSession]).pipe(Effect.ignore))),
      )
    }),
  },
  {
    name: "handoff-cross-tab",
    run: Effect.fnUntraced(function* (page) {
      const extension = yield* fetchStatus()
      if (extension.version !== "0.0.17") {
        return yield* Effect.fail(new Error(`handoff-cross-tab requires the built 0.0.17 shim; connected extension is ${extension.version ?? "unknown"}`))
      }
      const marker = `bc-handoff-a-${Date.now()}`
      const peerMarker = `bc-handoff-b-${Date.now()}`
      const waitingSession = `${marker}-session`
      const peerSession = `${peerMarker}-session`
      const peerPage = yield* playwright("create peer handoff page", () => page.context().newPage())
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* scopedHandoffFixture(marker)
          const peerUrl = fixture.afterUrl.replace(marker, peerMarker)
          yield* goto(page, fixture.beforeUrl)
          yield* goto(peerPage, peerUrl)
          yield* runBrowserControl(["session", "new", waitingSession])
          yield* runBrowserControl(["session", "new", peerSession])
          yield* runBrowserControl(["session", "adopt", "--session", waitingSession, "--target-url", marker])
          yield* runBrowserControl(["session", "adopt", "--session", peerSession, "--target-url", peerMarker])

          const executeFiber = yield* runBrowserControl([
            "execute",
            "--session",
            waitingSession,
            `await handoff('Resume only from tab A ${marker}', { timeoutMs: 30000 }); return { resumed: true, url: page.url() }`,
          ]).pipe(Effect.forkChild)
          yield* Effect.sleep("500 millis")
          const waitingOwnerPage = yield* scopedOwnerCdpPage({ sessionId: waitingSession, urlIncludes: marker })
          const peerOwnerPage = yield* scopedOwnerCdpPage({ sessionId: peerSession, urlIncludes: peerMarker })

          yield* waitingOwnerPage.waitFor(`document.querySelector('#__browser_control_page_status__')?.shadowRoot?.querySelector('button') != null`)
          const peerCompletionCount = yield* peerOwnerPage.evaluate<number>(`document.querySelector('#__browser_control_page_status__')?.shadowRoot?.querySelectorAll('button').length ?? 0`)
          if (peerCompletionCount !== 0) {
            return yield* Effect.fail(new Error(`peer tab exposed ${peerCompletionCount} handoff completion control(s)`))
          }

          const peerOutput = yield* runBrowserControl([
            "execute",
            "--session",
            peerSession,
            `await page.evaluate((title) => { document.title = title }, 'peer-active-${peerMarker}'); return { active: true, url: page.url() }`,
          ])
          if (!peerOutput.includes("active: true") || !peerOutput.includes(peerMarker)) {
            return yield* Effect.fail(new Error(`peer tab execute failed: ${peerOutput}`))
          }

          yield* peerOwnerPage.evaluate(`document.querySelector('#decoy')?.click()`)
          const premature = yield* Fiber.join(executeFiber).pipe(Effect.timeoutOption("200 millis"))
          if (Option.isSome(premature)) {
            return yield* Effect.fail(new Error(`handoff resumed from peer tab activity: ${premature.value}`))
          }

          yield* waitingOwnerPage.evaluate(`document.querySelector('#__browser_control_page_status__')?.shadowRoot?.querySelector('button')?.click()`)
          const output = yield* Fiber.join(executeFiber)
          if (!output.includes("resumed: true") || !output.includes(marker)) {
            return yield* Effect.fail(new Error(`handoff did not resume from tab A: ${output}`))
          }
          return output.trim()
        }).pipe(
          Effect.ensuring(
            Effect.all([
              boundedCleanup("close peer handoff page", () => peerPage.close()),
              runBrowserControl(["session", "delete", waitingSession]).pipe(Effect.ignore),
              runBrowserControl(["session", "delete", peerSession]).pipe(Effect.ignore),
            ]).pipe(Effect.ignore),
          ),
        ),
      )
    }),
  },
  {
    name: "handoff-target-detach",
    run: Effect.fnUntraced(function* (page) {
      const marker = `bc-handoff-detach-${Date.now()}`
      const smokeSession = `${marker}-session`
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* scopedHandoffFixture(marker)
          yield* goto(page, fixture.beforeUrl)
          yield* runBrowserControl(["session", "new", smokeSession])
          yield* runBrowserControl(["session", "adopt", "--session", smokeSession, "--target-url", marker])

          const executeFiber = yield* runBrowserControl([
            "execute",
            "--session",
            smokeSession,
            `await handoff('Detach ${marker}', { timeoutMs: 30000 }); return 'unexpected'`,
          ]).pipe(Effect.forkChild)
          yield* Effect.sleep("500 millis")
          const ownerPage = yield* scopedOwnerCdpPage({ sessionId: smokeSession, urlIncludes: marker })
          yield* ownerPage.waitFor(`document.querySelector('#__browser_control_page_status__')?.shadowRoot?.querySelector('button') != null`)
          yield* ownerPage.closeTarget()

          const promptOutcome = yield* Effect.result(Fiber.join(executeFiber)).pipe(Effect.timeoutOption("5 seconds"))
          if (Option.isNone(promptOutcome)) {
            return yield* Effect.fail(new Error("target detach did not cancel the handoff within 5 seconds"))
          }
          const outcome = promptOutcome.value
          if (outcome._tag === "Success" || !outcome.failure.message.includes("Handoff cancelled because its target detached")) {
            return yield* Effect.fail(new Error(`target detach did not cancel the handoff promptly: ${outcome._tag === "Success" ? outcome.success : outcome.failure.message}`))
          }
          return "handoff cancelled on exact target detach"
        }).pipe(Effect.ensuring(runBrowserControl(["session", "delete", smokeSession]).pipe(Effect.ignore))),
      )
    }),
  },
  {
    name: "dedicated-worker",
    run: Effect.fnUntraced(function* () {
      const marker = `bc-worker-${Date.now()}`
      const smokeSession = `${marker}-session`
      return yield* Effect.gen(function* () {
        yield* runBrowserControl(["session", "new", smokeSession])
        const output = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          `
await page.setContent('<main><h1>Dedicated worker fixture</h1></main>')
const workerPromise = page.waitForEvent('worker')
await page.evaluate(() => {
  const source = 'self.answer = 42; self.postMessage(self.answer)'
  const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
  globalThis.__browserControlSmokeWorker = worker
})
const worker = await workerPromise
return { answer: await worker.evaluate(() => globalThis.answer), url: worker.url() }
          `,
        ])
        if (!output.includes("answer: 42") || !output.includes("blob:")) {
          return yield* Effect.fail(new Error(`dedicated worker was not routed through Playwright: ${output}`))
        }
        return output.trim()
      }).pipe(Effect.ensuring(runBrowserControl(["session", "delete", smokeSession]).pipe(Effect.ignore)))
    }),
  },
  {
    name: "session-download-capability",
    run: Effect.fnUntraced(function* () {
      const marker = `bc-download-${Date.now()}`
      const smokeSession = `${marker}-session`
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* scopedDownloadFixture(marker)
          yield* runBrowserControl(["session", "new", smokeSession])
          const output = yield* runBrowserControl([
            "execute",
            "--session",
            smokeSession,
            `
await page.goto(${JSON.stringify(fixture.url)})
const startedAt = Date.now()
let message = ''
try {
  await page.waitForEvent('download', { timeout: 10_000 })
} catch (error) {
  message = error instanceof Error ? error.message : String(error)
}
return { message, durationMs: Date.now() - startedAt, fixtureReady: await page.getByRole('button', { name: 'Download JSON' }).isVisible() }
          `,
          ])
          if (!output.includes("Downloads are unavailable in Browser Control extension-backed tabs") || !output.includes("fixtureReady: true")) {
            return yield* Effect.fail(new Error(`session download did not return the expected capability error: ${output}`))
          }
          return output.trim()
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* runBrowserControl(["session", "delete", smokeSession]).pipe(Effect.ignore)
            }),
          ),
        ),
      )
    }),
  },
  {
    name: "execute-ghost-cursor",
    run: Effect.fnUntraced(function* () {
      const marker = `bc-cursor-${Date.now()}`
      const smokeSession = `${marker}-session`
      return yield* Effect.gen(function* () {
        yield* runBrowserControl(["session", "new", smokeSession])
        const output = yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          `
await page.setContent('<main style="height:300px"><button>Cursor target</button></main>')
await page.mouse.move(80, 90)
await page.mouse.down()
await page.mouse.up()
await page.waitForTimeout(150)
const automatic = await page.evaluate(() => {
  const element = document.getElementById('__browser_control_ghost_cursor__')
  return { exists: Boolean(element), motion: element?.dataset.motion, targetX: element?.dataset.targetX, targetY: element?.dataset.targetY, pressed: element?.dataset.pressed }
})
await page.getByRole('button', { name: 'Cursor target' }).click()
const locatorDriven = await page.evaluate(() => document.getElementById('__browser_control_ghost_cursor__')?.dataset.pressed)
await page.waitForTimeout(1000)
const faded = await page.evaluate(() => Boolean(document.getElementById('__browser_control_ghost_cursor__')))
await page.mouse.move(40, 50)
await page.waitForTimeout(100)
const returned = await page.evaluate(() => Boolean(document.getElementById('__browser_control_ghost_cursor__')))
await ghostCursor.hide()
await page.mouse.move(60, 70)
await page.waitForTimeout(100)
const disabled = await page.evaluate(() => Boolean(document.getElementById('__browser_control_ghost_cursor__')))
await showGhostCursor({ size: 20 })
await page.mouse.move(80, 90)
await page.waitForTimeout(1000)
const persistent = await page.evaluate(() => {
  const element = document.getElementById('__browser_control_ghost_cursor__')
  return { exists: Boolean(element), motion: element?.dataset.motion, targetX: element?.dataset.targetX, targetY: element?.dataset.targetY, transform: element?.style.transform }
})
await page.reload()
await page.waitForTimeout(100)
const restored = await page.evaluate(() => {
  const element = document.getElementById('__browser_control_ghost_cursor__')
  return { exists: Boolean(element), targetX: element?.dataset.targetX, targetY: element?.dataset.targetY, transform: element?.style.transform }
})
if (!automatic.exists || automatic.motion !== 'spring' || automatic.targetX !== '80' || automatic.targetY !== '90' || automatic.pressed !== 'false' || locatorDriven !== 'false' || faded || !returned || disabled || !persistent.exists || persistent.motion !== 'spring' || persistent.targetX !== '80' || persistent.targetY !== '90' || !persistent.transform?.includes('80px, 90px') || !restored.exists || restored.targetX !== '80' || restored.targetY !== '90' || !restored.transform?.includes('80px, 90px')) {
  throw new Error('ghost cursor automatic, fade, disable, persistent, or navigation behavior failed: ' + JSON.stringify({ automatic, locatorDriven, faded, returned, disabled, persistent, restored }))
}
return { automatic, locatorDriven, faded, returned, disabled, persistent, restored }
          `,
        ])
        if (!output.includes("motion: 'spring'") || !output.includes("targetX: '80'") || !output.includes("80px, 90px") || !output.includes("disabled: false")) {
          return yield* Effect.fail(new Error(`execute ghost cursor helper failed: ${output}`))
        }
        return output.trim()
      }).pipe(Effect.ensuring(runBrowserControl(["session", "delete", smokeSession]).pipe(Effect.ignore)))
    }),
  },
  {
    name: "recording-logical-session",
    run: Effect.fnUntraced(function* () {
      const marker = `bc-recording-${Date.now()}`
      const smokeSession = `${marker}-session`
      const outputPath = path.join(repoRoot, "tmp", `${marker}.webm`)
      return yield* Effect.gen(function* () {
        yield* runBrowserControl(["session", "new", smokeSession])
        yield* runBrowserControl([
          "execute",
          "--session",
          smokeSession,
          `await page.setContent('<main style="min-height:100vh;display:grid;place-items:center;background:#0f172a;color:white;font:48px system-ui"><h1 id="title">${marker}</h1></main>'); return await page.locator('#title').textContent()`,
        ])
        yield* runBrowserControl([
          "recording",
          "start",
          outputPath,
          "--session",
          smokeSession,
          "--mode",
          "cdp",
          "--frame-rate",
          "2",
          "--max-duration-ms",
          "30000",
        ])
        yield* Effect.sleep("1500 millis")
        const stopOutput = yield* runBrowserControl(["recording", "stop", "--session", smokeSession])
        const metadata = yield* readRecordingMetadata(`${outputPath}.json`)
        if (metadata.mode !== "cdp" || metadata.artifactType !== "webm" || metadata.frameCount < 1) {
          return yield* Effect.fail(new Error(`logical recording metadata invalid: ${formatValue(metadata)} stop=${stopOutput}`))
        }
        return { session: smokeSession, frameCount: metadata.frameCount, artifactType: metadata.artifactType }
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* runBrowserControl(["recording", "cancel", "--session", smokeSession]).pipe(Effect.ignore)
            yield* runBrowserControl(["session", "delete", smokeSession]).pipe(Effect.ignore)
            yield* removePath(outputPath)
            yield* removePath(`${outputPath}.json`)
          }),
        ),
      )
    }),
  },
  {
    name: "session-isolation",
    run: Effect.fnUntraced(function* () {
      const marker = `bc-session-${Date.now()}`
      const firstSession = `${marker}-a`
      const secondSession = `${marker}-b`
      return yield* Effect.gen(function* () {
        yield* runBrowserControl(["session", "new", firstSession])
        yield* runBrowserControl(["session", "new", secondSession])
        const firstOutput = yield* runBrowserControl([
          "execute",
          "--session",
          firstSession,
          `await page.goto('about:blank'); await page.setContent('<title>${firstSession}</title><h1>${firstSession}</h1>'); return { title: await page.title(), url: page.url() }`,
        ])
        const secondOutput = yield* runBrowserControl([
          "execute",
          "--session",
          secondSession,
          `await page.goto('about:blank'); await page.setContent('<title>${secondSession}</title><h1>${secondSession}</h1>'); return { title: await page.title(), url: page.url() }`,
        ])
        const firstAgain = yield* runBrowserControl([
          "execute",
          "--session",
          firstSession,
          "return { title: await page.title(), heading: await page.locator('h1').textContent() }",
        ])
        if (!firstOutput.includes(firstSession) || !secondOutput.includes(secondSession) || !firstAgain.includes(firstSession) || firstAgain.includes(secondSession)) {
          return yield* Effect.fail(new Error(`sessions were not isolated: ${JSON.stringify({ firstOutput, secondOutput, firstAgain })}`))
        }
        return { firstSession, secondSession, firstAgain: firstAgain.trim() }
      }).pipe(
        Effect.ensuring(
          Effect.all([
            runBrowserControl(["session", "delete", firstSession]).pipe(Effect.ignore),
            runBrowserControl(["session", "delete", secondSession]).pipe(Effect.ignore),
          ]).pipe(Effect.ignore),
        ),
      )
    }),
  },
  {
    // Regression for the two-client CDP broadcast bug: with session A's sandbox
    // still connected, a fresh session B's setContent/evaluate used to hang
    // forever because both Playwright clients were told about each other's tabs.
    name: "multi-client",
    run: Effect.fnUntraced(function* () {
      const marker = `bc-multi-${Date.now()}`
      const firstSession = `${marker}-a`
      const secondSession = `${marker}-b`
      return yield* Effect.gen(function* () {
        yield* runBrowserControl(["session", "new", firstSession])
        const firstOutput = yield* runBrowserControl([
          "execute",
          "--session",
          firstSession,
          "return await page.evaluate(() => 40 + 2)",
        ])
        if (!firstOutput.includes("42")) {
          return yield* Effect.fail(new Error(`first session evaluate failed: ${firstOutput}`))
        }
        // Session A's sandbox stays connected inside the relay; a fresh session
        // must still be able to drive its own new page without interference.
        yield* runBrowserControl(["session", "new", secondSession])
        const secondOutput = yield* runBrowserControl([
          "execute",
          "--session",
          secondSession,
          `
await page.setContent('<input id="one" placeholder="One"><input id="two"><textarea id="three"></textarea>')
await fillInput('#one', 'alpha')
await fillInputs(page, [
  { selector: '#two', value: 'beta' },
  { selector: '#three', value: 'gamma' },
])
return await page.evaluate(() => ({
  one: document.querySelector('#one')?.value,
  two: document.querySelector('#two')?.value,
  three: document.querySelector('#three')?.value,
}))
          `,
        ])
        if (!secondOutput.includes("alpha") || !secondOutput.includes("beta") || !secondOutput.includes("gamma")) {
          return yield* Effect.fail(new Error(`second session was blocked or interfered with: ${secondOutput}`))
        }
        const firstAgain = yield* runBrowserControl([
          "execute",
          "--session",
          firstSession,
          "return await page.evaluate(() => 'first-still-' + (40 + 2))",
        ])
        if (!firstAgain.includes("first-still-42")) {
          return yield* Effect.fail(new Error(`first session broke after second session ran: ${firstAgain}`))
        }
        return { firstSession, secondSession }
      }).pipe(
        Effect.ensuring(
          Effect.all([
            runBrowserControl(["session", "delete", firstSession]).pipe(Effect.ignore),
            runBrowserControl(["session", "delete", secondSession]).pipe(Effect.ignore),
          ]).pipe(Effect.ignore),
        ),
      )
    }),
  },
]

const main = Effect.fn("Smoke.main")(function* () {
  const selectedCases = cases.filter((testCase) => {
    return selectedCaseNames.size === 0 || selectedCaseNames.has(testCase.name)
  })
  if (selectedCases.length === 0) {
    return yield* Effect.fail(new Error(`No smoke cases matched: ${Array.from(selectedCaseNames).join(", ")}`))
  }

  yield* Console.log(`browser-control smoke: ${selectedCases.map((testCase) => testCase.name).join(", ")} x${repeatCount}`)
  yield* waitForExtensionConnected()
  const before = yield* fetchStatus()
  yield* Console.log(`extension status: ${formatValue(before)}`)

  const results = yield* Effect.forEach(
    range(repeatCount).flatMap((iteration) => {
      return selectedCases.map((testCase) => ({ iteration: iteration + 1, testCase }))
    }),
    ({ testCase, iteration }) =>
      runCase({ testCase, iteration }).pipe(
        Effect.tap((result) => printCaseResult(result)),
      ),
    { concurrency: 1 },
  )

  const failed = results.filter((result) => {
    return result.status === "fail" || result.status === "unexpected-pass"
  })
  const summary = summarize(results)
    yield* Console.log(`summary: ${formatValue(summary)}`)
  if (failed.length > 0) {
    return yield* Effect.fail(new Error(`${failed.length} smoke case(s) need attention`))
  }
})

function printCaseResult(result: CaseRunResult): Effect.Effect<void> {
  return Effect.gen(function* () {
    const icon = result.status === "pass" ? "PASS" : result.status === "expected-fail" ? "XFAIL" : result.status === "unexpected-pass" ? "XPASS" : "FAIL"
    yield* Console.log(`${icon} ${result.name}#${result.iteration} ${result.durationMs}ms after=${result.afterStatus.activeTargets} child=${result.afterStatus.childTargets} cdp=${result.afterStatus.cdpClients}`)
    if (result.value !== undefined) {
      yield* Console.log(formatValue(result.value))
    }
    if (result.error) {
      yield* Console.error(result.error)
    }
  })
}

const runCase = Effect.fn("Smoke.runCase")(function* (options: {
  readonly testCase: SmokeCase
  readonly iteration: number
}): Effect.fn.Return<CaseRunResult, Error> {
  const beforeStatus = yield* fetchStatus()
  const start = yield* Clock.currentTimeMillis
  const outcome = yield* Effect.matchEffect(withPage(options.testCase.run), {
    onFailure: (error) => Effect.succeed({ _tag: "Failure" as const, error }),
    onSuccess: (value) => Effect.succeed({ _tag: "Success" as const, value }),
  })
  yield* waitForRelayCleanup(beforeStatus)
  const afterStatus = yield* fetchStatus()
  const end = yield* Clock.currentTimeMillis
  const cleanupError = cleanupRegression({ before: beforeStatus, after: afterStatus })

  if (outcome._tag === "Success") {
    if (cleanupError) {
      return {
        name: options.testCase.name,
        iteration: options.iteration,
        status: "fail",
        durationMs: end - start,
        beforeStatus,
        afterStatus,
        error: cleanupError,
      }
    }
    return {
      name: options.testCase.name,
      iteration: options.iteration,
      status: options.testCase.expectedFailure ? "unexpected-pass" : "pass",
      durationMs: end - start,
      beforeStatus,
      afterStatus,
      value: outcome.value,
    }
  }

  return {
    name: options.testCase.name,
    iteration: options.iteration,
    status: options.testCase.expectedFailure ? "expected-fail" : "fail",
    durationMs: end - start,
    beforeStatus,
    afterStatus,
    error: cleanupError ? `${formatError(outcome.error)}\ncleanup:\n${cleanupError}` : formatError(outcome.error),
  }
})

const withPage = Effect.fnUntraced(function* <A>(run: (page: Page) => Effect.Effect<A, Error>) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* scopedBrowser()
      const context = yield* playwright("get browser context", () => getBrowserContext(browser))
      const page = yield* playwright("create page", () => context.newPage())
      return yield* run(page).pipe(Effect.ensuring(boundedCleanup("close smoke page", () => page.close())))
    }),
  )
})

const scopedOwnerCdpPage = Effect.fnUntraced(function* (options: {
  readonly sessionId: string
  readonly urlIncludes: string
}) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => makeOwnerCdpPage(options),
      catch: (cause) => new Error(`connect owner CDP page for ${options.sessionId}`, { cause }),
    }),
    (page) => Effect.all([
      page.closeTarget().pipe(Effect.ignore),
      boundedCleanup("close owner CDP page", page.close),
    ], { concurrency: 1 }).pipe(Effect.asVoid),
  )
})

async function makeOwnerCdpPage(options: { readonly sessionId: string; readonly urlIncludes: string }): Promise<OwnerCdpPage> {
  const [versionResponse, targetsResponse] = await Promise.all([
    fetch(new URL("/json/version", endpointUrl)),
    fetch(new URL("/json/list", endpointUrl)),
  ])
  const version = await versionResponse.json() as { readonly webSocketDebuggerUrl?: unknown }
  const targets = await targetsResponse.json() as Array<{
    readonly id?: unknown
    readonly url?: unknown
    readonly browserControlSessionId?: unknown
  }>
  if (typeof version.webSocketDebuggerUrl !== "string") {
    throw new Error("Relay did not provide a browser websocket URL")
  }
  const target = targets.find((candidate) => {
    return candidate.browserControlSessionId === options.sessionId &&
      typeof candidate.url === "string" && candidate.url.includes(options.urlIncludes)
  })
  if (!target || typeof target.id !== "string") {
    throw new Error(`No target owned by ${options.sessionId} matched ${options.urlIncludes}`)
  }

  const websocketUrl = new URL(version.webSocketDebuggerUrl)
  websocketUrl.searchParams.set("browserControlSessionId", options.sessionId)
  const socket = new WebSocket(websocketUrl)
  let nextId = 1
  const pending = new Map<number, {
    readonly resolve: (value: Record<string, unknown>) => void
    readonly reject: (error: Error) => void
    readonly timeout: NodeJS.Timeout
  }>()
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as {
      readonly id?: unknown
      readonly result?: unknown
      readonly error?: { readonly message?: unknown }
    }
    if (typeof message.id !== "number") {
      return
    }
    const waiter = pending.get(message.id)
    if (!waiter) {
      return
    }
    pending.delete(message.id)
    clearTimeout(waiter.timeout)
    if (message.error) {
      waiter.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Owner CDP command failed"))
      return
    }
    waiter.resolve(message.result && typeof message.result === "object" && !Array.isArray(message.result)
      ? message.result as Record<string, unknown>
      : {})
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })

  const command = (method: string, params: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Owner CDP command timed out: ${method}`))
      }, 10_000)
      pending.set(id, { resolve, reject, timeout })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  const announced = await command("Target.attachToTarget", { targetId: target.id, flatten: true })
  if (typeof announced.sessionId !== "string") {
    socket.close()
    throw new Error("Owner CDP target attach did not return a session id")
  }
  // The first attach announces the root; the second returns a client-local
  // alias that remains routable if Chrome re-announces the root generation.
  const attached = await command("Target.attachToTarget", { targetId: target.id, flatten: true })
  if (typeof attached.sessionId !== "string") {
    socket.close()
    throw new Error("Owner CDP target alias did not return a session id")
  }
  const targetSessionId = attached.sessionId
  const closeTarget = (): Effect.Effect<void, Error> => Effect.tryPromise({
    try: async () => {
      await command("Target.closeTarget", { targetId: target.id })
    },
    catch: (cause) => cause instanceof Error ? cause : new Error("Close owner CDP target", { cause }),
  })
  const evaluate = <A>(expression: string): Effect.Effect<A, Error> => Effect.tryPromise({
    try: async () => {
      const response = await command("Runtime.evaluate", { expression, returnByValue: true }, targetSessionId)
      if (response.exceptionDetails) {
        throw new Error(`Owner CDP evaluation failed: ${JSON.stringify(response.exceptionDetails)}`)
      }
      const result = response.result
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        return undefined as A
      }
      return (result as { readonly value?: A }).value as A
    },
    catch: (cause) => cause instanceof Error ? cause : new Error("Owner CDP evaluation failed", { cause }),
  })
  return {
    closeTarget,
    evaluate,
    navigate: (url) => Effect.tryPromise({
      try: async () => {
        await command("Page.navigate", { url }, targetSessionId)
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await Effect.runPromise(evaluate<string>("location.href")) === url) {
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error(`Owner CDP navigation did not reach ${url}`)
      },
      catch: (cause) => cause instanceof Error ? cause : new Error(`Owner CDP navigation failed: ${url}`, { cause }),
    }),
    waitFor: (expression) => Effect.gen(function* () {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (yield* evaluate<boolean>(expression)) {
          return
        }
        yield* Effect.sleep("50 millis")
      }
      return yield* Effect.fail(new Error(`Owner CDP condition timed out: ${expression}`))
    }),
    close: async () => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timeout)
        waiter.reject(new Error("Owner CDP socket closed"))
      }
      pending.clear()
      socket.terminate()
    },
  }
}

const scopedBrowser = Effect.fnUntraced(function* () {
  return yield* Effect.acquireRelease(
    playwright("connect over CDP", () => chromium.connectOverCDP(endpointUrl)),
    (browser) => boundedCleanup("close browser", () => browser.close()),
  )
})

const scopedRedirectFixture = Effect.fnUntraced(function* (marker: string) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => new Promise<{ readonly server: http.Server; readonly startUrl: string; readonly finalUrl: string }>((resolve, reject) => {
        const server = http.createServer((request, response) => {
          if (request.url === "/start") {
            response.writeHead(302, { location: "/final" })
            response.end()
            return
          }
          if (request.url === "/final") {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
            response.end(`<!doctype html><title>${marker}</title><main id="marker">${marker}</main>`)
            return
          }
          response.writeHead(404)
          response.end("Not found")
        })
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject)
          const address = server.address()
          if (!address || typeof address === "string") {
            server.close()
            reject(new Error("redirect fixture did not receive a TCP address"))
            return
          }
          const origin = `http://127.0.0.1:${address.port}`
          resolve({ server, startUrl: `${origin}/start`, finalUrl: `${origin}/final` })
        })
      }),
      catch: (cause) => new Error("start redirect fixture", { cause }),
    }),
    (fixture) => boundedCleanup("close redirect fixture", () => new Promise<void>((resolve) => fixture.server.close(() => resolve()))),
  )
})

const scopedHandoffFixture = Effect.fnUntraced(function* (marker: string) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => new Promise<{ readonly server: http.Server; readonly beforeUrl: string; readonly afterUrl: string }>((resolve, reject) => {
        const server = http.createServer((request, response) => {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
          if (request.url?.startsWith("/before")) {
            response.end(`<!doctype html><title>${marker} before</title><main>${marker} before</main>`)
            return
          }
          if (request.url?.startsWith("/after")) {
            response.end(`<!doctype html><title>${marker} after</title><main>${marker} after<button id="decoy">Unrelated page button</button></main>`)
            return
          }
          response.end("<!doctype html><title>not found</title>")
        })
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject)
          const address = server.address()
          if (!address || typeof address === "string") {
            server.close()
            reject(new Error("handoff fixture did not receive a TCP address"))
            return
          }
          const origin = `http://127.0.0.1:${address.port}`
          resolve({
            server,
            beforeUrl: `${origin}/before?${marker}`,
            afterUrl: `${origin}/after?${marker}`,
          })
        })
      }),
      catch: (cause) => new Error("start handoff fixture", { cause }),
    }),
    (fixture) => boundedCleanup("close handoff fixture", () => new Promise<void>((resolve) => fixture.server.close(() => resolve()))),
  )
})

const scopedDownloadFixture = Effect.fnUntraced(function* (marker: string) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => new Promise<{ readonly server: http.Server; readonly url: string }>((resolve, reject) => {
        const server = http.createServer((request, response) => {
          if (request.url === "/payload") {
            response.writeHead(200, { "content-type": "application/json" })
            response.end(JSON.stringify({ marker }))
            return
          }
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
          response.end(`<!doctype html>
            <title>Download fixture</title>
            <button>Download JSON</button>
            <script>
              document.querySelector('button').addEventListener('click', async () => {
                const payload = await fetch('/payload')
                const blob = await payload.blob()
                const anchor = document.createElement('a')
                anchor.href = URL.createObjectURL(blob)
                anchor.download = 'fixture.json'
                anchor.click()
              })
            </script>`)
        })
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject)
          const address = server.address()
          if (!address || typeof address === "string") {
            server.close()
            reject(new Error("download fixture did not receive a TCP address"))
            return
          }
          resolve({ server, url: `http://127.0.0.1:${address.port}/` })
        })
      }),
      catch: (cause) => new Error("start download fixture", { cause }),
    }),
    (fixture) => boundedCleanup("close download fixture", () => new Promise<void>((resolve) => fixture.server.close(() => resolve()))),
  )
})

function getBrowserContext(browser: Browser): Promise<BrowserContext> {
  const existing = browser.contexts()[0]
  if (existing) {
    return Promise.resolve(existing)
  }
  return browser.newContext()
}

const closeOwningBrowser = Effect.fnUntraced(function* (page: Page, label: string) {
  const browser = page.context().browser()
  if (!browser) {
    return
  }
  yield* playwright(label, () => browser.close())
})

const goto = Effect.fnUntraced(function* (page: Page, url: string) {
  yield* playwright(`goto ${url}`, () => page.goto(url, { timeout: 20_000 }))
})

const click = Effect.fnUntraced(function* (locator: ReturnType<Page["locator"]>, label: string) {
  yield* playwright(`click ${label}`, () => locator.click({ timeout: 10_000 }))
})

const fill = Effect.fnUntraced(function* (locator: ReturnType<Page["locator"]>, value: string, label: string) {
  yield* playwright(`fill ${label}`, () => locator.fill(value, { timeout: 10_000 }))
})

const fillInput = Effect.fnUntraced(function* (locator: ReturnType<Page["locator"]>, value: string, label: string) {
  yield* playwright(`fill input ${label}`, () =>
    locator.evaluate((element, nextValue) => {
      if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
        throw new Error("fillInput expects an input or textarea locator")
      }
      const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement
      const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set
      const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
      element.focus()
      if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
        prototypeValueSetter.call(element, nextValue)
      } else {
        element.value = nextValue
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }))
      element.dispatchEvent(new Event("change", { bubbles: true }))
      element.blur()
    }, value),
  )
})

const fillInputs = Effect.fnUntraced(function* (
  page: Page,
  fields: ReadonlyArray<{ readonly selector: string; readonly value: string }>,
  label: string,
) {
  yield* playwright(`fill inputs ${label}`, () =>
    page.evaluate((inputFields) => {
      return inputFields.map((field) => {
        const matches = document.querySelectorAll(field.selector)
        if (matches.length !== 1) {
          throw new Error(`fillInputs expects exactly one match for selector: ${field.selector}; got ${matches.length}`)
        }
        const element = matches[0]
        if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
          throw new Error(`fillInputs expects input or textarea selector: ${field.selector}`)
        }
        const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement
        const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
        element.focus()
        if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
          prototypeValueSetter.call(element, field.value)
        } else {
          element.value = field.value
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: field.value }))
        element.dispatchEvent(new Event("change", { bubbles: true }))
        element.blur()
        return field.selector
      })
    }, fields),
  )
})

const textContent = Effect.fnUntraced(function* (locator: ReturnType<Page["locator"]>, label: string, timeout = 10_000) {
  return yield* playwright(`text ${label}`, () => locator.textContent({ timeout }))
})

const inputValue = Effect.fnUntraced(function* (locator: ReturnType<Page["locator"]>, label: string) {
  return yield* playwright(`input ${label}`, () => locator.inputValue({ timeout: 10_000 }))
})

const clickSelector = Effect.fnUntraced(function* (page: Page, selector: string, label: string) {
  yield* Effect.catchIf(
    playwright(`click selector ${label}`, () =>
    page.evaluate((targetSelector) => {
      const matches = document.querySelectorAll(targetSelector)
      if (matches.length !== 1) {
        throw new Error(`clickSelector expects exactly one match for selector: ${targetSelector}; got ${matches.length}`)
      }
      const element = matches[0]
      if (!(element instanceof HTMLElement)) {
        throw new Error(`clickSelector expects HTMLElement selector: ${targetSelector}`)
      }
      element.click()
    }, selector),
    ),
    (error) => (error.cause instanceof Error ? error.cause.message : error.message).includes("Execution context was destroyed"),
    () => Effect.void,
  )
})

const attribute = Effect.fnUntraced(function* (locator: ReturnType<Page["locator"]>, name: string, label: string) {
  return yield* playwright(`attribute ${label}`, () => locator.getAttribute(name, { timeout: 10_000 }))
})

function playwright<A>(label: string, run: () => PromiseLike<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: () => run(),
    catch: (cause) => new Error(label, { cause }),
  })
}

function boundedCleanup(label: string, run: () => PromiseLike<unknown>, timeoutMs = 5_000): Effect.Effect<void> {
  return Effect.promise(() => {
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, timeoutMs)
      Promise.resolve(run()).then(
        () => {
          clearTimeout(timeout)
          resolve()
        },
        () => {
          clearTimeout(timeout)
          resolve()
        },
      )
    })
  }).pipe(Effect.withSpan(`Smoke.cleanup.${label}`))
}

type RunBrowserControlOptions = {
  readonly retryOnTimeout?: boolean
}

function runBrowserControl(args: readonly string[], options: RunBrowserControlOptions = {}): Effect.Effect<string, Error> {
  return runBrowserControlOnce(args).pipe(
    Effect.catchIf(
      (error) => options.retryOnTimeout === true && isBrowserControlTimeout(error),
      () => runBrowserControlOnce(args),
    ),
  )
}

function runBrowserControlOnce(args: readonly string[]): Effect.Effect<string, Error> {
  return Effect.callback<string, Error>((resume) => {
    let completed = false
    const endpointPort = new URL(endpointUrl).port
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(endpointPort ? { BROWSER_CONTROL_PORT: endpointPort } : {}),
    }
    delete childEnv.BROWSER_CONTROL_TARGET_URL
    delete childEnv.BROWSER_CONTROL_TARGET_INDEX
    delete childEnv.BROWSER_CONTROL_SESSION
    const child = cp.execFile(
      process.execPath,
      ["--import", "tsx", localCliPath, ...args],
      {
        cwd: repoRoot,
        env: childEnv,
        timeout: browserControlTimeoutMs,
      },
      (error, stdout, stderr) => {
        completed = true
        if (error) {
          resume(Effect.fail(new Error(`browser-control ${args.join(" ")} failed: ${stderr || stdout}`, { cause: error })))
          return
        }
        resume(Effect.succeed(stdout))
      },
    )
    return Effect.sync(() => {
      if (!completed) {
        child.kill()
      }
    })
  })
}

function isBrowserControlTimeout(error: Error): boolean {
  const cause = error.cause
  if (!cause || typeof cause !== "object" || Array.isArray(cause)) {
    return false
  }
  const execError = cause as { readonly killed?: unknown; readonly signal?: unknown; readonly code?: unknown }
  return execError.killed === true || execError.signal === "SIGTERM" || execError.code === 130
}

function readRecordingMetadata(filePath: string): Effect.Effect<RecordingMetadata, Error> {
  return Effect.tryPromise({
    try: async () => parseRecordingMetadata(JSON.parse(await fs.readFile(filePath, "utf8"))),
    catch: (cause) => new Error(`read recording metadata ${filePath}`, { cause }),
  })
}

function parseRecordingMetadata(value: unknown): RecordingMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected recording metadata object")
  }
  const metadata = value as {
    readonly mode?: unknown
    readonly artifactType?: unknown
    readonly sessionId?: unknown
    readonly frameCount?: unknown
  }
  if (typeof metadata.mode !== "string" || typeof metadata.artifactType !== "string" || typeof metadata.sessionId !== "string" || typeof metadata.frameCount !== "number") {
    throw new Error("Invalid recording metadata shape")
  }
  return {
    mode: metadata.mode,
    artifactType: metadata.artifactType,
    sessionId: metadata.sessionId,
    frameCount: metadata.frameCount,
  }
}

function removePath(filePath: string): Effect.Effect<void> {
  return Effect.promise(() => fs.rm(filePath, { recursive: true, force: true }))
}

function findPageByTitle({ context, title }: { readonly context: BrowserContext; readonly title: string }): Effect.Effect<Page | undefined, Error> {
  return Effect.tryPromise({
    try: async () => {
      const matches = await Promise.all(
        context.pages().map(async (page) => {
          return { page, title: await page.title() }
        }),
      )
      return matches.find((match) => {
        return match.title === title
      })?.page
    },
    catch: (cause) => new Error(`find page by title ${title}`, { cause }),
  })
}

const waitForFrameUrl = Effect.fnUntraced(function* (options: {
  readonly page: Page
  readonly urlIncludes: string
}) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const frame: Frame | undefined = options.page.frames().find((candidate) => {
      return candidate.url().includes(options.urlIncludes)
    })
    if (frame) {
      return frame
    }
    yield* Effect.sleep("100 millis")
  }
  return undefined
})

const fetchStatus = Effect.fnUntraced(function* () {
  const response = yield* Effect.tryPromise({
    try: () => fetch(new URL("/extension/status", endpointUrl)),
    catch: (cause) => new Error("fetch extension status", { cause }),
  })
  return yield* Effect.tryPromise({
    try: async () => parseExtensionStatus(await response.json()),
    catch: (cause) => new Error("parse extension status", { cause }),
  })
})

const waitForRelayCleanup = Effect.fnUntraced(function* (baseline: ExtensionStatus) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = yield* fetchStatus()
    if (!cleanupRegression({ before: baseline, after: status })) {
      return status
    }
    yield* Effect.sleep("100 millis")
  }
  return yield* fetchStatus()
})

const waitForExtensionConnected = Effect.fnUntraced(function* () {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = yield* fetchStatus()
    if (status.connected) {
      return status
    }
    yield* Effect.sleep("100 millis")
  }
  return yield* Effect.fail(new Error("Browser Control extension did not connect within 10s"))
})

function parseExtensionStatus(value: unknown): ExtensionStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected extension status object")
  }
  const status = value as { readonly connected?: unknown; readonly version?: unknown; readonly activeTargets?: unknown; readonly childTargets?: unknown; readonly cdpClients?: unknown; readonly sessions?: unknown }
  if (typeof status.connected !== "boolean" || typeof status.activeTargets !== "number") {
    throw new Error("Invalid extension status shape")
  }
  return {
    connected: status.connected,
    version: typeof status.version === "string" ? status.version : null,
    activeTargets: status.activeTargets,
    childTargets: typeof status.childTargets === "number" ? status.childTargets : 0,
    cdpClients: typeof status.cdpClients === "number" ? status.cdpClients : 0,
    sessionIds: parseStatusSessionIds(status.sessions),
  }
}

function cleanupRegression(options: { readonly before: ExtensionStatus; readonly after: ExtensionStatus }): string | undefined {
  const leakedSessions = options.after.sessionIds.filter((id) => {
    return !options.before.sessionIds.includes(id)
  })
  const leaks: string[] = []
  if (options.after.activeTargets > options.before.activeTargets) {
    leaks.push(`activeTargets ${options.before.activeTargets} -> ${options.after.activeTargets}`)
  }
  if (options.after.childTargets > options.before.childTargets) {
    leaks.push(`childTargets ${options.before.childTargets} -> ${options.after.childTargets}`)
  }
  if (options.after.cdpClients > options.before.cdpClients) {
    leaks.push(`cdpClients ${options.before.cdpClients} -> ${options.after.cdpClients}`)
  }
  if (leakedSessions.length > 0) {
    leaks.push(`sessions leaked: ${leakedSessions.join(", ")}`)
  }
  return leaks.length > 0 ? `Smoke case leaked relay resources: ${leaks.join("; ")}` : undefined
}

function parseStatusSessionIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return []
    }
    const session = item as { readonly id?: unknown }
    return typeof session.id === "string" ? [session.id] : []
  })
}

function summarize(results: readonly CaseRunResult[]) {
  return {
    pass: results.filter((result) => result.status === "pass").length,
    fail: results.filter((result) => result.status === "fail").length,
    expectedFail: results.filter((result) => result.status === "expected-fail").length,
    unexpectedPass: results.filter((result) => result.status === "unexpected-pass").length,
  }
}

function parseCaseFilter(value: string | undefined): Set<string> {
  if (!value) {
    return new Set()
  }
  return new Set(value.split(",").map((item) => item.trim()).filter((item) => item.length > 0))
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined
  }
  return parsed
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index)
}

function formatValue(value: unknown): string {
  return util.inspect(value, { depth: 8, colors: false, maxArrayLength: 50, maxStringLength: 4000 })
}

function formatError(error: Error): string {
  const lines = [error.stack ?? error.message]
  if (error.cause) {
    lines.push("cause:")
    lines.push(formatValue(error.cause))
  }
  return lines.join("\n")
}

main().pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
