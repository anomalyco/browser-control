// A scripted policy that solves every task the way a careful person would. It proves each task is
// solvable through the real UI, so a failing model run is the model's failure, not the fixture's.
import type { Page } from "playwright-core"
import type { GauntletPolicy, PolicyContext } from "./policy.ts"

type Script = (page: Page, act: (label: string, run: () => Promise<unknown>) => Promise<void>, inputs: Readonly<Record<string, string>>) => Promise<void>

const exact = { exact: true } as const

const rejectCookies: Script = async (page, act) => act("reject cookies", () => page.getByRole("button", { name: "Reject" }).click())

const storeSearch: Script = async (page, act, inputs) => {
  await act("type the query", () => page.getByRole("searchbox", { name: "Search Junglemart" }).fill(inputs.query ?? ""))
  await act("search", () => page.getByRole("button", { name: "Go" }).click())
}

const declineProtection: Script = async (page, act) => act("decline protection", () => page.getByRole("button", { name: "No thanks" }).click())

const eatsSearch = (store: string): Script => async (page, act, inputs) => {
  await act("type the query", () => page.getByRole("searchbox", { name: "Search Grubber" }).fill(inputs.query ?? ""))
  await act("search", () => page.getByRole("button", { name: "Search", exact: true }).click())
  await act(`open ${store}`, () => page.getByRole("link", { name: store, exact: true }).click())
}

const dismissPromo: Script = async (page, act) => act("dismiss promo", () => page.getByRole("button", { name: "Not now" }).click())

const scripts: Record<string, Script> = {
  "store-add-variant": async (page, act, inputs) => {
    await rejectCookies(page, act, inputs)
    await storeSearch(page, act, inputs)
    await act("open the Anker Nano 20W", () => page.getByRole("link", { name: "Anker Nano 20W USB-C Charger", exact: true }).click())
    await act("choose White", () => page.getByRole("button", { name: "White", exact: true }).click())
    await act("add to cart", () => page.getByRole("button", { name: "Add to Cart" }).click())
    await declineProtection(page, act, inputs)
  },
  "store-oos-fallback": async (page, act, inputs) => {
    await rejectCookies(page, act, inputs)
    await storeSearch(page, act, inputs)
    await act("open the Hearth skillet", () => page.getByRole("link", { name: "Hearth Pre-Seasoned Cast-Iron Skillet" }).click())
    await act("check 12-inch", () => page.getByRole("button", { name: "12-inch (unavailable)" }).click())
    await act("choose 10-inch", () => page.getByRole("button", { name: "10-inch", exact: true }).click())
    await act("add to cart", () => page.getByRole("button", { name: "Add to Cart" }).click())
    await declineProtection(page, act, inputs)
  },
  "store-pagination-qty": async (page, act, inputs) => {
    await rejectCookies(page, act, inputs)
    await storeSearch(page, act, inputs)
    await act("go to page 2", () => page.getByRole("navigation", { name: "Pagination" }).getByRole("link", { name: "2", exact: true }).click())
    await act("open the A5 dot-grid", () => page.getByRole("link", { name: "Fieldnote Dot-Grid Notebook, A5", exact: true }).click())
    await act("quantity 3", () => page.getByLabel("Quantity:").selectOption("3"))
    await act("add to cart", () => page.getByRole("button", { name: "Add to Cart" }).click())
    await declineProtection(page, act, inputs)
  },
  "store-checkout": async (page, act, inputs) => {
    await rejectCookies(page, act, inputs)
    await storeSearch(page, act, inputs)
    await act("open the TrailPeak jacket", () => page.getByRole("link", { name: "TrailPeak Packable Rain Jacket", exact: true }).click())
    await act("choose Navy", () => page.getByRole("button", { name: "Navy", exact: true }).click())
    await act("choose M", () => page.getByRole("button", { name: "M", exact: true }).click())
    await act("add to cart", () => page.getByRole("button", { name: "Add to Cart" }).click())
    await declineProtection(page, act, inputs)
    await act("checkout", () => page.getByRole("link", { name: "Proceed to checkout" }).click())
    for (const [label, key] of [["Full name", "name"], ["Street address", "street"], ["City", "city"], ["ZIP code", "zip"]] as const)
      await act(`fill ${label}`, () => page.getByLabel(label, exact).fill(inputs[key] ?? ""))
    await act("state OR", () => page.getByLabel("State", exact).selectOption("OR"))
    await act("save address", () => page.getByRole("button", { name: "Use this address" }).click())
    await act("standard shipping", () => page.getByLabel(/Standard \(FREE\)/).check())
    await act("continue", () => page.getByRole("button", { name: "Continue to payment" }).click())
    await fillCard(page, act, inputs)
    await act("place order", () => page.getByRole("button", { name: "Place your order" }).click())
  },
  "store-promo-expedited": async (page, act, inputs) => {
    await rejectCookies(page, act, inputs)
    await act("checkout", () => page.getByRole("link", { name: "Proceed to checkout" }).click())
    await act("use saved address", () => page.getByRole("link", { name: "Use this address" }).click())
    await act("expedited shipping", () => page.getByLabel(/Expedited/).check())
    await act("continue", () => page.getByRole("button", { name: "Continue to payment" }).click())
    await act("type promo", () => page.getByLabel("Gift card or promo code").fill(inputs.promo ?? ""))
    await act("apply promo", () => page.getByRole("button", { name: "Apply" }).click())
    await fillCard(page, act, inputs)
    await act("place order", () => page.getByRole("button", { name: "Place your order" }).click())
  },
  "eats-required-options": async (page, act, inputs) => {
    await act("type address", () => page.getByLabel("Delivery address", exact).fill(inputs.address ?? ""))
    await act("save address", () => page.getByRole("button", { name: "Save address" }).click())
    await dismissPromo(page, act, inputs)
    await eatsSearch("Tony's Slice")(page, act, inputs)
    await act("open Margherita", () => page.getByRole("link", { name: "Margherita Pizza" }).click())
    await act("Large", () => page.getByLabel(/Large 16"/).check())
    await act("Extra basil", () => page.getByLabel(/Extra basil/).check())
    await act("add to order", () => page.getByRole("button", { name: "Add to order" }).click())
  },
  "eats-closed-fallback": async (page, act, inputs) => {
    await dismissPromo(page, act, inputs)
    await eatsSearch("Lemongrass Thai Kitchen")(page, act, inputs)
    await act("open Pad Thai", () => page.getByRole("link", { name: "Pad Thai", exact: true }).click())
    await act("Chicken", () => page.getByLabel("Chicken", exact).check())
    await act("Mild", () => page.getByLabel("Mild", exact).check())
    await act("add to order", () => page.getByRole("button", { name: "Add to order" }).click())
  },
  "eats-lazy-menu": async (page, act, inputs) => {
    await eatsSearch("Casa Verde Taqueria")(page, act, inputs)
    await act("scroll to the end of the menu", () => page.mouse.wheel(0, 3000))
    await act("open the bowl", () => page.getByRole("link", { name: "Chicken Burrito Bowl" }).click())
    for (const choice of ["Brown rice", "Black beans", "Mild tomato salsa"]) await act(choice, () => page.getByLabel(choice, exact).check())
    await act("add to order", () => page.getByRole("button", { name: "Add to order" }).click())
  },
  "eats-pickup-checkout": async (page, act, inputs) => {
    await eatsSearch("Bean There Coffee")(page, act, inputs)
    await act("open Iced Latte", () => page.getByRole("link", { name: "Iced Latte" }).click())
    await act("Medium", () => page.getByLabel(/Medium/).check())
    await act("Oat milk", () => page.getByLabel(/Oat milk/).check())
    await act("quantity 2", () => page.getByLabel("Quantity").selectOption("2"))
    await act("add to order", () => page.getByRole("button", { name: "Add to order" }).click())
    await act("view cart", () => page.getByRole("link", { name: "View cart" }).click())
    await act("checkout", () => page.getByRole("link", { name: "Go to checkout" }).click())
    await act("skip upsell", () => page.getByRole("button", { name: "No thanks, continue" }).click())
    await act("pickup", () => page.getByLabel(/Pickup at/).check())
    await act("decline membership", () => page.getByLabel(/Add Grubber One/).uncheck())
    await fillCard(page, act, inputs)
    await act("place order", () => page.getByRole("button", { name: "Place order" }).click())
  },
  "eats-switch-cart": async (page, act, inputs) => {
    await eatsSearch("Sakura Sushi")(page, act, inputs)
    await act("open Spicy Tuna Roll", () => page.getByRole("link", { name: "Spicy Tuna Roll" }).click())
    await act("add to order", () => page.getByRole("button", { name: "Add to order" }).click())
    await act("start a new order", () => page.getByRole("button", { name: "New order" }).click())
  },
}

async function fillCard(page: Page, act: (label: string, run: () => Promise<unknown>) => Promise<void>, inputs: Readonly<Record<string, string>>) {
  await act("card number", () => page.getByLabel(/Card number/).fill(inputs.card ?? ""))
  if (inputs.cardname || inputs.name) await act("name on card", () => page.getByLabel("Name on card").fill(inputs.cardname ?? inputs.name ?? ""))
  await act("expiry", () => page.getByLabel(/Expir/).fill(inputs.exp ?? ""))
  await act("cvc", () => page.getByLabel(/CVC/).fill(inputs.cvc ?? ""))
  const store = page.url().includes("/store/")
  if (store) await act("use card", () => page.getByRole("button", { name: "Use this payment method" }).click())
}

export const reference: GauntletPolicy = {
  name: "reference",
  run: async ({ task, page, step }: PolicyContext) => {
    const script = scripts[task.id]
    if (!script) return { status: "error", detail: `no reference script for ${task.id}` }
    const act = async (label: string, run: () => Promise<unknown>) => {
      const started = performance.now()
      await run()
      await page.waitForLoadState("domcontentloaded")
      await step({ op: "SCRIPT", label, ms: Math.round(performance.now() - started) })
    }
    await script(page, act, task.inputs)
    return { status: "done" }
  },
}
