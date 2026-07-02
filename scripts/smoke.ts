#!/usr/bin/env tsx
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Clock, Console, Effect } from "effect"
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright-core"
import cp from "node:child_process"
import fs from "node:fs/promises"
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
    run: Effect.fnUntraced(function* (page) {
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
    }),
  },
  {
    name: "local-checkout",
    run: Effect.fnUntraced(function* (page) {
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
  { selector: '#two', value: 'beta' },
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
await showGhostCursor({ size: 20 })
await page.mouse.move(80, 90)
await page.mouse.down()
await page.mouse.up()
await page.waitForTimeout(150)
const beforeHide = await page.evaluate(() => {
  const element = document.getElementById('__browser_control_ghost_cursor__')
  return { exists: Boolean(element), transform: element?.style.transform, pressed: element?.dataset.pressed }
})
await ghostCursor.hide()
const afterHide = await page.evaluate(() => Boolean(document.getElementById('__browser_control_ghost_cursor__')))
if (!beforeHide.exists || !beforeHide.transform?.includes('70px, 80px') || beforeHide.pressed !== 'false' || afterHide) {
  throw new Error('ghost cursor did not show, move, release, and hide: ' + JSON.stringify({ beforeHide, afterHide }))
}
return { beforeHide, afterHide }
          `,
        ])
        if (!output.includes("70px, 80px") || !output.includes("afterHide: false")) {
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
      const outputPath = path.join(repoRoot, "tmp", `${marker}-frames`)
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
        const metadata = yield* readRecordingMetadata(path.join(outputPath, "metadata.json"))
        if (metadata.mode !== "cdp" || metadata.artifactType !== "frame-directory" || metadata.frameCount < 1) {
          return yield* Effect.fail(new Error(`logical recording metadata invalid: ${formatValue(metadata)} stop=${stopOutput}`))
        }
        return { session: smokeSession, frameCount: metadata.frameCount, artifactType: metadata.artifactType }
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* runBrowserControl(["recording", "cancel", "--session", smokeSession]).pipe(Effect.ignore)
            yield* runBrowserControl(["session", "delete", smokeSession]).pipe(Effect.ignore)
            yield* removePath(outputPath)
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

const scopedBrowser = Effect.fnUntraced(function* () {
  return yield* Effect.acquireRelease(
    playwright("connect over CDP", () => chromium.connectOverCDP(endpointUrl)),
    (browser) => boundedCleanup("close browser", () => browser.close()),
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
