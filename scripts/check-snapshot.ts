import assert from "node:assert/strict"
import { chromium } from "playwright-core"
import { createSnapshotHelpers } from "../src/execute.ts"

// Real DOM and Playwright locators: deliberately separate from browser-free unit tests.
const browser = await chromium.launch()
const page = await browser.newPage()
const failures: string[] = []
const check = async (name: string, run: () => Promise<void>) => {
  try {
    await run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`)
  }
}
try {
  for (const [type, role] of [["number", "spinbutton"], ["search", "searchbox"]] as const) {
    await check(`${type} input refs`, async () => {
      await page.setContent(`<main><label>Amount<input type="${type}" name="amount"></label></main>`)
      const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
      const outline = await snapshot()
      assert.match(outline, new RegExp(`${role} "Amount"`))
      const id = outline.match(/ref=(e\d+)/)?.[1]
      assert.ok(id)
      await ref(id).fill("12", { timeout: 1_000 })
      assert.equal(await page.getByRole(role, { name: "Amount" }).inputValue(), "12")
    })
  }
  await check("native summary ref", async () => {
    await page.setContent('<main><details><summary>Show details</summary><p>Revealed</p></details></main>')
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    const id = outline.match(/(?:button|summary) "Show details" \[ref=(e\d+)/)?.[1]
    assert.ok(id, outline)
    await ref(id).click({ timeout: 1_000 })
    assert.equal(await page.locator("details").getAttribute("open"), "")
  })
  await check("portal dialog outside main", async () => {
    await page.setContent('<main><h1>Background</h1><button>Open account</button></main><div role="dialog" aria-modal="true" aria-label="New account"><label>Name<input></label><button>Save account</button></div>')
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    assert.match(outline, /dialog "New account"/)
    const id = outline.match(/button "Save account" \[ref=(e\d+)/)?.[1]
    assert.ok(id, outline)
    assert.equal(await ref(id).count(), 1)
    assert.match(await snapshot({ within: "main" }), /heading "Background"/)
  })
  await check("nested product list budget", async () => {
    await page.setContent(`<main><h1>Products</h1>${Array.from({ length: 100 }, (_, i) => `<ul><li><ul><li><a href="#product-${i}">Strawberry product ${i}</a><button>Add product ${i}</button></li></ul></li></ul>`).join("")}</main>`)
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot({ maxItems: 30 })
    assert.match(outline, /link "Strawberry product 0"/)
    assert.match(outline, /list "List"/)
    const id = outline.match(/link "Strawberry product 0" \[ref=(e\d+)/)?.[1]
    assert.ok(id, outline)
    assert.equal(await ref(id).count(), 1)
    assert.ok(outline.split("\n").length <= 31)
  })
  await check("explicit summary role is preserved", async () => {
    await page.setContent('<main><details><summary role="button">Explicit button</summary><p>Details</p></details></main>')
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    assert.match(await snapshot(), /button "Explicit button" \[ref=e1/)
    await ref("e1").click({ timeout: 1_000 })
    assert.equal(await page.locator("details").getAttribute("open"), "")
  })
  await check("non-modal portal and background remain visible", async () => {
    await page.setContent('<main><h1>Background</h1></main><div role="dialog" aria-label="Help"><button>Close help</button></div>')
    const { snapshot } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    assert.match(outline, /heading "Background"/)
    assert.match(outline, /button "Close help"/)
  })
  await check("hidden modal does not hide main", async () => {
    await page.setContent('<main><h1>Background</h1></main><div role="dialog" aria-modal="true" hidden><button>Invisible</button></div>')
    const { snapshot } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    assert.match(outline, /heading "Background"/)
    assert.doesNotMatch(outline, /Invisible/)
  })
  await check("button image alt text matches Playwright", async () => {
    await page.setContent('<button><img alt="Garden Bowl"> <span>Garden Bowl</span> <span>$15.00</span></button>')
    const { snapshot } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    const name = outline.match(/button "([^"]+)"/)?.[1]
    assert.ok(name, outline)
    assert.equal(await page.getByRole("button", { name, exact: true }).count(), 1, `Snapshot name must locate the real button: ${outline}`)
    await page.setContent('<button><img alt="Ignore me" aria-hidden="true"> <img alt=""/> Save</button>')
    assert.match(await snapshot(), /button "Save"/)
  })
  await check("button visible text beats title attribute while icon-only button falls back to title", async () => {
    await page.setContent('<main><button title="Toggle annotation mode (A)">Annotate</button><button title="Close"><svg width="10" height="10"></svg></button></main>')
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    assert.match(outline, /button "Annotate" \[ref=e1\]/)
    assert.match(outline, /button "Close" \[ref=e2\]/)
    assert.equal(await ref("e1").count(), 1)
    assert.equal(await ref("e2").count(), 1)
  })
  await check("inline code and React SSR comment nodes match Playwright getByRole", async () => {
    await page.setContent(`
      <main>
        <a href="#open"><div>Open</div><span aria-hidden="true">183</span><span>&nbsp;(<!-- -->183<!-- -->)</span></a>
        <a href="#issue"><span><code>@effect/atom-react</code>: <code>getServerSnapshot</code> mismatch, see <code>Atom</code></span></a>
      </main>
    `)
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    assert.match(outline, /link "Open \(183\)" \[ref=e1\]/)
    assert.match(outline, /link "@effect\/atom-react: getServerSnapshot mismatch, see Atom" \[ref=e2\]/)
    assert.equal(await ref("e1").count(), 1)
    assert.equal(await ref("e2").count(), 1)
  })
  await check("display:contents main and table rows remain visible in snapshot", async () => {
    await page.setContent(`
      <nav><a href="#nav">Global Nav</a></nav>
      <main style="display: contents">
        <div>
          <h1>ShadowRoot</h1>
          <table>
            <tr style="display: contents"><th style="display: block">Property</th><td style="display: block"><a href="#mode">ShadowRoot.mode</a></td></tr>
          </table>
        </div>
      </main>
    `)
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    assert.doesNotMatch(outline, /Global Nav/)
    assert.match(outline, /heading "ShadowRoot" \[level=1\]/)
    assert.match(outline, /row "Property: ShadowRoot\.mode"/)
    assert.match(outline, /link "ShadowRoot\.mode" \[ref=e1\]/)
    assert.equal(await ref("e1").count(), 1)
  })
  await check("open Shadow DOM controls are captured and actionable via ref()", async () => {
    await page.setContent(`
      <main>
        <div id="shadow-host"></div>
        <input id="submit-btn" type="submit" value="Place Order">
      </main>
    `)
    await page.evaluate(() => {
      const host = document.getElementById("shadow-host")!
      const root = host.attachShadow({ mode: "open" })
      root.innerHTML = '<button id="inside-shadow">Confirm Shadow</button>'
      root.getElementById("inside-shadow")!.addEventListener("click", () => {
        host.setAttribute("data-clicked", "yes")
      })
    })
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    assert.match(outline, /button "Confirm Shadow" \[ref=e1\]/)
    assert.match(outline, /button "Place Order" \[ref=e2\]/)
    await ref("e1").click()
    assert.equal(await page.locator("#shadow-host").getAttribute("data-clicked"), "yes")
    assert.equal(await ref("e2").count(), 1)
  })
  await check("snapshot tolerates document without body or documentElement", async () => {
    await page.setContent("<main><button>Before</button></main>")
    await page.evaluate(() => {
      document.body?.remove()
    })
    const { snapshot } = createSnapshotHelpers(page, { selectors: new Map() })
    assert.equal(await snapshot(), "")
    await page.evaluate(() => {
      document.documentElement?.remove()
    })
    assert.equal(await snapshot(), "")
  })
  await check("custom button[role=combobox] and portal listbox/menu options outside main", async () => {
    await page.setContent(`
      <main>
        <aside data-slot="sidebar">
          <ul>${Array.from({ length: 12 }, (_, i) => `<li><a href="#doc-${i}">Doc ${i}</a></li>`).join("")}</ul>
        </aside>
        <h1>Select</h1>
        <button type="button" role="combobox" aria-expanded="false" id="fruit-trigger"><span>Select a fruit</span></button>
      </main>
      <div role="listbox" id="fruit-portal" style="display: none">
        <div role="option" aria-selected="false" id="opt-apple">Apple</div>
        <div role="option" aria-selected="false" id="opt-pineapple">Pineapple</div>
      </div>
      <ul role="menu" id="sort-portal" style="display: none">
        <li role="menuitemradio" aria-checked="true">Newest</li>
        <li role="menuitemradio" aria-checked="false" id="sort-oldest">Oldest</li>
      </ul>
    `)
    await page.evaluate(() => {
      document.getElementById("fruit-trigger")!.addEventListener("click", () => {
        document.getElementById("fruit-trigger")!.setAttribute("aria-expanded", "true")
        document.getElementById("fruit-portal")!.style.display = "block"
      })
      document.getElementById("opt-pineapple")!.addEventListener("click", () => {
        document.querySelector("#fruit-trigger span")!.textContent = "Pineapple"
        document.getElementById("fruit-portal")!.style.display = "none"
        document.getElementById("sort-portal")!.style.display = "block"
      })
    })
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const initial = await snapshot()
    assert.match(initial, /navigation "Navigation" \[12 controls\]/)
    assert.doesNotMatch(initial, /Doc 11/)
    const comboRef = initial.match(/combobox "Select a fruit" \[ref=(e\d+)/)?.[1]
    assert.ok(comboRef, initial)
    await ref(comboRef).click({ timeout: 1_000 })

    const withPortal = await snapshot()
    const pineappleRef = withPortal.match(/option "Pineapple" \[ref=(e\d+)/)?.[1]
    assert.ok(pineappleRef, withPortal)
    await ref(pineappleRef).click({ timeout: 1_000 })

    const withMenu = await snapshot()
    assert.match(withMenu, /combobox "Pineapple"/)
    assert.match(withMenu, /menuitemradio "Newest" \[ref=e\d+ checked\]/)
    const oldestRef = withMenu.match(/menuitemradio "Oldest" \[ref=(e\d+) unchecked\]/)?.[1]
    assert.ok(oldestRef, withMenu)
    assert.equal(await ref(oldestRef).count(), 1)
  })
  await check("header search controls, heading-link deduplication, and descendant aria-label in links", async () => {
    await page.setContent(`
      <header>
        <nav><a href="#nav">Global Nav</a></nav>
        <input placeholder="Search restaurants, cuisines, etc.">
      </header>
      <main>
        <article>
          <a href="#venue-1"><h2>Cha Cha Cha</h2></a>
          <a href="#venue-2"><h2>Izakaya Rintaro</h2></a>
        </article>
        <h3><a href="#issue-1">rpc: request-level defect</a></h3>
        <a href="#crab" id="crab-link">
          <span>#1 most liked</span>
          <button aria-label="Quick Add"><svg><title>Plus small</title></svg></button>
          <span>Crab Rangoon 8 pcs</span>
        </a>
        <button disabled class="skeleton"></button>
      </main>
    `)
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    assert.doesNotMatch(outline, /Global Nav/)
    assert.doesNotMatch(outline, /button "button" \[[^\]]*disabled/)
    assert.match(outline, /textbox "Search restaurants, cuisines, etc\." \[ref=e\d+\]/)
    assert.match(outline, /link "Cha Cha Cha" \[ref=e\d+\]/)
    assert.match(outline, /link "Izakaya Rintaro" \[ref=e\d+\]/)
    assert.doesNotMatch(outline, /heading "Cha Cha Cha"/)
    assert.doesNotMatch(outline, /heading "rpc: request-level defect"/)
    const crabRef = outline.match(/link "#1 most liked Quick Add Crab Rangoon 8 pcs" \[ref=(e\d+)\]/)?.[1]
    assert.ok(crabRef, outline)
    assert.equal(await ref(crabRef).count(), 1)
  })
  await check("layout tables, markdown listitem paragraphs, and duplicate article card links", async () => {
    await page.setContent(`
      <main>
        <table id="layout-outer">
          <tr><td>
            <table id="layout-inner">
              ${Array.from({ length: 22 }, (_, i) => `
                <tr class="athing"><td>${i + 1}.</td><td class="titleline"><a href="#story-${i}">Story title ${i}</a> <span class="sitebit">(<a href="#site-${i}">example.com</a>)</span></td></tr>
                <tr><td></td><td>10 points by user <a href="#comments-${i}">${i + 5} comments</a></td></tr>
              `).join("")}
            </table>
          </td></tr>
        </table>
        <ul>
          <li><p>Node.js 18 or newer when running Effect on Node.js.</p></li>
        </ul>
        <article>
          <h2>elemen-ts — Build reactive UIs</h2>
          <a href="#post-1">elemen-ts — Build reactive UIs</a>
          <a href="#post-1">elemen-ts — Build reactive UIs</a>
          <a href="#post-1-comments">8 Go to comments</a>
        </article>
      </main>
    `)
    const { snapshot } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot({ maxItems: 60 })
    assert.doesNotMatch(outline, /table "Table"/)
    assert.match(outline, /link "Story title 0" \[ref=e\d+\]/)
    assert.match(outline, /link "5 comments" \[ref=e\d+\]/)
    assert.match(outline, /listitem "Node\.js 18 or newer when running Effect on Node\.js\."/)
    assert.doesNotMatch(outline, /- p "Node\.js 18 or newer/)
    assert.doesNotMatch(outline, /heading "elemen-ts — Build reactive UIs"/)
    assert.equal((outline.match(/link "elemen-ts — Build reactive UIs"/g) ?? []).length, 1)
  })
  await check("adaptive hydration settle waits for async skeleton replacement without manual sleep", async () => {
    await page.setContent('<main aria-busy="true"><div class="skeleton">Loading...</div></main>')
    await page.evaluate(() => {
      window.setTimeout(() => {
        const main = document.querySelector("main")!
        main.removeAttribute("aria-busy")
        main.innerHTML = "<h1>Hydrated Dashboard</h1><button>Launch</button>"
      }, 60)
    })
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    assert.match(outline, /heading "Hydrated Dashboard" \[level=1\]/)
    const btnRef = outline.match(/button "Launch" \[ref=(e\d+)\]/)?.[1]
    assert.ok(btnRef, outline)
    assert.equal(await ref(btnRef).count(), 1)
  })
  await check("opacity:0 radio and checkbox inputs with visible associated labels are captured and clickable via ref()", async () => {
    await page.setContent(`
      <main>
        <fieldset role="radiogroup">
          <legend>Do you have a fever and rash?</legend>
          <span style="position:relative;display:inline-block">
            <input id="q-yes" type="radio" name="q1" style="opacity:0;position:absolute;inset:0;z-index:2" />
            <label for="q-yes" style="display:inline-block;padding:8px 16px">Yes</label>
          </span>
          <span style="position:relative;display:inline-block">
            <input id="q-no" type="radio" name="q1" style="opacity:0;position:absolute;inset:0;z-index:0" />
            <label for="q-no" style="position:relative;z-index:2;display:inline-block;padding:8px 16px">No</label>
          </span>
        </fieldset>
      </main>
    `)
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const outline = await snapshot()
    const yesRef = outline.match(/radio "Yes" \[ref=(e\d+) unchecked\]/)?.[1]
    const noRef = outline.match(/radio "No" \[ref=(e\d+) unchecked\]/)?.[1]
    assert.ok(yesRef && noRef, outline)
    await ref(yesRef).click()
    assert.match(await snapshot(), /radio "Yes" \[ref=e\d+ checked\]/)
    await ref(noRef).click()
    assert.match(await snapshot(), /radio "No" \[ref=e\d+ checked\]/)
  })
  await check("sibling tab bar outside main, clickable table rows, and aria-hidden app modal dialogs", async () => {
    await page.setContent(`
      <div id="app">
        <nav><button>Anomaly (Dev)</button><a href="/internal">Internal</a></nav>
        <div class="workspace-body">
          <div data-tab-nav>
            <a href="#overview">Overview</a>
            <a href="#logs" aria-current="page">Logs</a>
            <a href="#models">Models</a>
          </div>
          <main>
            <h2>Logs</h2>
            <table>
              <tr><th>Time</th><th>Status</th><th>Model</th></tr>
              <tr role="button" tabindex="0" aria-label="View request req-1"><td>09:27:32</td><td>410 Rejected</td><td>deepseek-v4-pro</td></tr>
            </table>
          </main>
        </div>
      </div>
    `)
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const initial = await snapshot()
    assert.match(initial, /button "Anomaly \(Dev\)" \[ref=e\d+\]/)
    assert.match(initial, /link "Logs" \[ref=e\d+ current=page\]/)
    assert.match(initial, /link "Models" \[ref=e\d+\]/)
    const rowMatch = initial.match(/button "View request req-1 — Time: 09:27:32 \| Status: 410 Rejected \| Model: deepseek-v4-pro" \[ref=(e\d+)\]/)
    assert.ok(rowMatch?.[1], initial)
    assert.equal(await ref(rowMatch[1]).count(), 1)

    await page.evaluate(() => {
      document.getElementById("app")!.setAttribute("aria-hidden", "true")
      const modal = document.createElement("div")
      modal.setAttribute("role", "dialog")
      modal.innerHTML = '<h2>Search</h2><input type="search" placeholder="Search docs">'
      document.body.appendChild(modal)
    })
    const modalSnap = await snapshot()
    assert.match(modalSnap, /searchbox "Search docs" \[ref=e\d+\]/)
    assert.doesNotMatch(modalSnap, /View request req-1/)
  })
  await check("article story title priority, clean pre/code extraction, and button combobox ref stability across aria-hidden portals", async () => {
    await page.setContent(`
      <main id="content">
        <h1>Search Stories</h1>
        <h2><a href="#primitives" aria-label="the primitives permalink"></a>The primitives: string, number, and boolean</h2>
        <p>Effect is a production TypeScript framework providing composable concurrency, structured error handling, and dependency injection.</p>
        <button id="fruit-select" role="combobox" aria-expanded="false">Select a fruit</button>
        <pre><div role="tablist"><button role="tab" aria-selected="true">bun</button></div><pre><code>bun add effect</code><button>Copy</button></pre></pre>
        <article class="Story">
          <div>
            <a href="https://news.ycombinator.com/item?id=1"><span>Effect – Build robust apps in TypeScript</span></a>
            <a href="https://effect.website/">(https://effect.website/)</a>
          </div>
          <div>
            <a href="https://news.ycombinator.com/item?id=1">127 points</a>
            <a href="https://news.ycombinator.com/user?id=alice">alice</a>
            <a href="https://news.ycombinator.com/item?id=1">74 comments</a>
          </div>
        </article>
        <ul><li>Plain text item</li></ul>
      </main>
    `)
    const { snapshot, ref } = createSnapshotHelpers(page, { selectors: new Map() })
    const snap = await snapshot({ maxItems: 6 })
    assert.match(snap, /link "Effect – Build robust apps in TypeScript" \[ref=e\d+\]/)
    assert.doesNotMatch(snap, /74 comments/)
    assert.doesNotMatch(snap, /list "List"/)

    const full = await snapshot()
    assert.match(full, /heading "The primitives: string, number, and boolean" \[level=2\]/)
    assert.doesNotMatch(full, /the primitives permalink/)
    assert.match(full, /p "Effect is a production TypeScript framework/)
    assert.match(full, /code "bun add effect"/)
    assert.doesNotMatch(full, /bun add effectCopy/)
    const comboRef = full.match(/combobox "Select a fruit" \[ref=(e\d+)/)?.[1]
    assert.ok(comboRef, full)
    await page.evaluate(() => {
      document.getElementById("content")!.setAttribute("aria-hidden", "true")
      const btn = document.getElementById("fruit-select")!
      btn.setAttribute("aria-expanded", "true")
      btn.textContent = "Pineapple"
    })
    assert.equal(await ref(comboRef).count(), 1)
  })
} finally {
  await browser.close()
}
assert.deepEqual(failures, [], "Snapshot regressions failed")
