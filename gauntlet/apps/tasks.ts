// Gauntlet tasks: a goal, the only text the agent may type, an optional seeded state, ordered
// milestones (to locate where a run stalled) and a final-state grade read from the app server.
import type { EatsLine, RunState, StoreLine } from "./state.ts"

type Check = { readonly ok: boolean; readonly detail: string }
type Milestone = { readonly name: string; readonly reached: (s: RunState) => boolean }

export type GauntletTask = {
  readonly id: string
  readonly app: "store" | "eats"
  readonly difficulty: "easy" | "medium" | "hard"
  readonly goal: string
  /** Every text value the agent may type. Agents must never type anything else. */
  readonly inputs: Readonly<Record<string, string>>
  readonly start: string
  readonly maxSteps: number
  readonly obstacles: readonly string[]
  readonly seed?: (s: RunState) => void
  readonly milestones: readonly Milestone[]
  readonly grade: (s: RunState) => Check
}

const has = (s: RunState, name: string, match: (d: Record<string, unknown>) => boolean = () => true) =>
  s.events.some((e) => e.name === name && match((e.detail ?? {}) as Record<string, unknown>))
const same = (a: string | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.toLowerCase()
const json = (v: unknown) => JSON.stringify(v)

const storeLine = (l: StoreLine | undefined, id: string, color: string | undefined, size: string | undefined, qty: number) =>
  !!l && l.productId === id && l.color === color && l.size === size && l.qty === qty && !l.protection

function storeCartIs(s: RunState, id: string, color: string | undefined, size: string | undefined, qty: number): Check {
  const ok = s.store.cart.length === 1 && storeLine(s.store.cart[0], id, color, size, qty) && s.store.orders.length === 0
  return { ok, detail: `cart=${json(s.store.cart)} orders=${s.store.orders.length}` }
}

const optionsEqual = (a: Record<string, string[]>, b: Record<string, string[]>) =>
  json(Object.entries(a).filter(([, v]) => v.length).sort()) === json(Object.entries(b).sort())
const eatsLine = (l: EatsLine | undefined, restaurant: string, item: string, options: Record<string, string[]>) =>
  !!l && l.restaurantId === restaurant && l.itemId === item && optionsEqual(l.options, options)

function eatsCartIs(s: RunState, restaurant: string, item: string, qty: number, options: Record<string, string[]>): Check {
  const ok = s.eats.cart.length === 1 && eatsLine(s.eats.cart[0], restaurant, item, options) && s.eats.cart[0]!.qty === qty && s.eats.orders.length === 0 && !has(s, "eats:promo", (d) => d.choice === "trial")
  return { ok, detail: `cart=${json(s.eats.cart)} orders=${s.eats.orders.length} trial=${has(s, "eats:promo", (d) => d.choice === "trial")}` }
}

const card = { card: "4242 4242 4242 4242", exp: "12/30", cvc: "123" }
const seededAddress = (s: RunState) => {
  s.eats.address = "500 Market St, San Francisco, CA 94105"
}

const ada = { name: "Ada Lovelace", street: "12 Analytical Way", city: "Portland", state: "OR", zip: "97201" }

export const tasks: readonly GauntletTask[] = [
  {
    id: "store-add-variant",
    app: "store",
    difficulty: "easy",
    goal: "On Junglemart, search for Anker Nano 20W and add one Anker Nano 20W USB-C Charger in the color White to your cart. Do not check out.",
    inputs: { query: "Anker Nano 20W" },
    start: "/store/",
    maxSteps: 20,
    obstacles: ["cookie banner", "sponsored lookalike", "default color is Black", "protection-plan upsell"],
    milestones: [
      { name: "opened the product", reached: (s) => has(s, "store:view", (d) => d.product === "anker-nano-20w") },
      { name: "chose White", reached: (s) => has(s, "store:view", (d) => d.product === "anker-nano-20w" && d.color === "White") },
      { name: "added White to cart", reached: (s) => s.store.cart.some((l) => l.productId === "anker-nano-20w" && l.color === "White") },
    ],
    grade: (s) => storeCartIs(s, "anker-nano-20w", "White", undefined, 1),
  },
  {
    id: "store-oos-fallback",
    app: "store",
    difficulty: "medium",
    goal: "On Junglemart, search for cast iron skillet and add one Hearth Pre-Seasoned Cast-Iron Skillet to your cart: the 12-inch size if it is in stock, otherwise the 10-inch size. Do not check out.",
    inputs: { query: "cast iron skillet" },
    start: "/store/",
    maxSteps: 20,
    obstacles: ["cookie banner", "sponsored lookalike", "12-inch out of stock", "size required", "protection-plan upsell"],
    milestones: [
      { name: "opened the product", reached: (s) => has(s, "store:view", (d) => d.product === "skillet-hearth") },
      { name: "added a Hearth skillet", reached: (s) => s.store.cart.some((l) => l.productId === "skillet-hearth") },
      { name: "added the 10-inch", reached: (s) => s.store.cart.some((l) => l.productId === "skillet-hearth" && l.size === "10-inch") },
    ],
    grade: (s) => storeCartIs(s, "skillet-hearth", undefined, "10-inch", 1),
  },
  {
    id: "store-pagination-qty",
    app: "store",
    difficulty: "medium",
    goal: "On Junglemart, search for notebook and add 3 of the Fieldnote Dot-Grid Notebook, A5 (not the A4) to your cart. Do not check out.",
    inputs: { query: "notebook" },
    start: "/store/",
    maxSteps: 20,
    obstacles: ["cookie banner", "result on page 2", "A4 decoy", "quantity", "protection-plan upsell"],
    milestones: [
      { name: "searched", reached: (s) => has(s, "store:search", (d) => String(d.q).includes("notebook")) },
      { name: "opened the A5 notebook", reached: (s) => has(s, "store:view", (d) => d.product === "nb-dot-a5") },
      { name: "added the A5 notebook", reached: (s) => s.store.cart.some((l) => l.productId === "nb-dot-a5") },
      { name: "quantity is 3", reached: (s) => s.store.cart.some((l) => l.productId === "nb-dot-a5" && l.qty === 3) },
    ],
    grade: (s) => storeCartIs(s, "nb-dot-a5", undefined, undefined, 3),
  },
  {
    id: "store-checkout",
    app: "store",
    difficulty: "hard",
    goal: "On Junglemart, search for rain jacket and buy one TrailPeak Packable Rain Jacket in Navy, size M. Ship it to Ada Lovelace, 12 Analytical Way, Portland, OR 97201, using the free Standard shipping. Pay with card 4242 4242 4242 4242, name on card Ada Lovelace, expiry 12/30, CVC 123, and place the order. Do not add anything else.",
    inputs: { query: "rain jacket", name: ada.name, street: ada.street, city: ada.city, zip: ada.zip, ...card },
    start: "/store/",
    maxSteps: 45,
    obstacles: ["cookie banner", "kids' jacket decoy", "size required", "protection-plan upsell", "address validation", "paid shipping pre-selected", "card validation"],
    milestones: [
      { name: "opened the jacket", reached: (s) => has(s, "store:view", (d) => d.product === "jacket-trailpeak") },
      { name: "Navy M in cart", reached: (s) => has(s, "store:cart-add", (d) => d.product === "jacket-trailpeak" && d.color === "Navy" && d.size === "M") },
      { name: "address saved", reached: (s) => has(s, "store:address", (d) => same(d.street as string, ada.street) && d.zip === ada.zip) },
      { name: "standard shipping", reached: (s) => has(s, "store:shipping", (d) => d.shipping === "standard") },
      { name: "card accepted", reached: (s) => has(s, "store:payment") },
      { name: "order placed", reached: (s) => s.store.orders.length > 0 },
    ],
    grade: (s) => {
      const o = s.store.orders[0]
      const ok = s.store.orders.length === 1 && !!o && o.lines.length === 1 && storeLine(o.lines[0], "jacket-trailpeak", "Navy", "M", 1) && o.shipping === "standard" &&
        same(o.address.name, ada.name) && same(o.address.street, ada.street) && same(o.address.city, ada.city) && o.address.state === ada.state && o.address.zip === ada.zip
      return { ok, detail: `orders=${json(s.store.orders)}` }
    },
  },
  {
    id: "store-promo-expedited",
    app: "store",
    difficulty: "hard",
    goal: "Your Junglemart cart already holds a Volta electric kettle and your shipping address is saved. Check out with Expedited shipping, apply the promo code SAVE10, pay with card 4242 4242 4242 4242, name on card Grace Hopper, expiry 08/29, CVC 456, and place the order.",
    inputs: { promo: "SAVE10", card: card.card, cardname: "Grace Hopper", exp: "08/29", cvc: "456" },
    start: "/store/cart",
    maxSteps: 30,
    obstacles: ["cookie banner", "paid shipping pre-selected", "promo form beside the card form", "card validation"],
    seed: (s) => {
      s.store.cart.push({ productId: "kettle-volta", color: "Steel", qty: 1, protection: false })
      s.store.address = { name: "Grace Hopper", street: "1 Compiler Ct", city: "New York", state: "NY", zip: "10001" }
    },
    milestones: [
      { name: "expedited shipping", reached: (s) => has(s, "store:shipping", (d) => d.shipping === "expedited") },
      { name: "promo applied", reached: (s) => has(s, "store:promo", (d) => d.ok === true) },
      { name: "card accepted", reached: (s) => has(s, "store:payment") },
      { name: "order placed", reached: (s) => s.store.orders.length > 0 },
    ],
    grade: (s) => {
      const o = s.store.orders[0]
      const ok = s.store.orders.length === 1 && !!o && o.promo === "SAVE10" && o.shipping === "expedited" && o.lines.length === 1 && storeLine(o.lines[0], "kettle-volta", "Steel", undefined, 1)
      return { ok, detail: `orders=${json(s.store.orders)}` }
    },
  },
  {
    id: "eats-required-options",
    app: "eats",
    difficulty: "medium",
    goal: "On Grubber, set the delivery address to 500 Market St, San Francisco, CA 94105. Then search for Tony's Slice and add one Margherita Pizza from Tony's Slice to your cart, size Large, with Extra basil. Do not check out and do not sign up for anything.",
    inputs: { address: "500 Market St, San Francisco, CA 94105", query: "Tony's Slice" },
    start: "/eats/",
    maxSteps: 25,
    obstacles: ["address gate", "membership promo modal", "required size", "optional toppings"],
    milestones: [
      { name: "address set", reached: (s) => !!s.eats.address },
      { name: "promo dismissed", reached: (s) => s.eats.promoDismissed },
      { name: "opened Tony's Slice", reached: (s) => has(s, "eats:view-store", (d) => d.restaurant === "tonys-slice") },
      { name: "added a Margherita", reached: (s) => s.eats.cart.some((l) => l.itemId === "margherita") },
    ],
    grade: (s) => eatsCartIs(s, "tonys-slice", "margherita", 1, { size: ["Large 16\""], extras: ["Extra basil"] }),
  },
  {
    id: "eats-closed-fallback",
    app: "eats",
    difficulty: "medium",
    goal: "On Grubber, search for pad thai and add one Pad Thai with Chicken, Mild spice, to your cart from a Thai restaurant that is open right now. Do not check out and do not sign up for anything.",
    inputs: { query: "pad thai" },
    start: "/eats/",
    maxSteps: 20,
    obstacles: ["membership promo modal", "top-rated match is closed", "two required option groups"],
    seed: seededAddress,
    milestones: [
      { name: "opened an open Thai restaurant", reached: (s) => has(s, "eats:view-store", (d) => d.restaurant === "lemongrass") },
      { name: "added Pad Thai", reached: (s) => s.eats.cart.some((l) => l.itemId === "pad-thai") },
    ],
    grade: (s) => eatsCartIs(s, "lemongrass", "pad-thai", 1, { protein: ["Chicken"], spice: ["Mild"] }),
  },
  {
    id: "eats-lazy-menu",
    app: "eats",
    difficulty: "medium",
    goal: "On Grubber, search for Casa Verde and add one Chicken Burrito Bowl (the bowl, not the burrito) from Casa Verde Taqueria to your cart with Brown rice, Black beans and Mild tomato salsa, and no extras. Do not check out.",
    inputs: { query: "Casa Verde" },
    start: "/eats/",
    maxSteps: 20,
    obstacles: ["burrito decoy", "bowls load only when scrolled into view", "three required groups"],
    seed: (s) => {
      seededAddress(s)
      s.eats.promoDismissed = true
    },
    milestones: [
      { name: "opened Casa Verde", reached: (s) => has(s, "eats:view-store", (d) => d.restaurant === "casa-verde") },
      { name: "added the bowl", reached: (s) => s.eats.cart.some((l) => l.itemId === "bowl-chicken") },
    ],
    grade: (s) => eatsCartIs(s, "casa-verde", "bowl-chicken", 1, { rice: ["Brown rice"], beans: ["Black beans"], salsa: ["Mild tomato salsa"] }),
  },
  {
    id: "eats-pickup-checkout",
    app: "eats",
    difficulty: "hard",
    goal: "On Grubber, search for Bean There and order 2 Iced Lattes from Bean There Coffee, each Medium with Oat milk, for pickup (not delivery). Pay with card 4242 4242 4242 4242, expiry 12/30, CVC 123, and place the order. Do not add anything else or sign up for anything.",
    inputs: { query: "Bean There", ...card },
    start: "/eats/",
    maxSteps: 35,
    obstacles: ["required size and milk", "quantity", "add-on upsell", "delivery is the default", "membership box pre-checked", "card validation"],
    seed: (s) => {
      seededAddress(s)
      s.eats.promoDismissed = true
    },
    milestones: [
      { name: "opened Bean There", reached: (s) => has(s, "eats:view-store", (d) => d.restaurant === "bean-there") },
      { name: "added iced lattes", reached: (s) => has(s, "eats:cart-add", (d) => d.itemId === "iced-latte") },
      { name: "passed the upsell", reached: (s) => has(s, "eats:upsell") },
      { name: "order placed", reached: (s) => s.eats.orders.length > 0 },
    ],
    grade: (s) => {
      const o = s.eats.orders[0]
      const want = { size: ["Medium"], milk: ["Oat milk"] }
      const ok = s.eats.orders.length === 1 && !!o && o.restaurantId === "bean-there" && o.mode === "pickup" && !o.membership &&
        o.lines.every((l) => eatsLine(l, "bean-there", "iced-latte", want)) && o.lines.reduce((n, l) => n + l.qty, 0) === 2
      return { ok, detail: `orders=${json(s.eats.orders)}` }
    },
  },
  {
    id: "eats-switch-cart",
    app: "eats",
    difficulty: "medium",
    goal: "Your Grubber cart holds a pizza from Tony's Slice. Replace it: search for Sakura Sushi and start a new order with one Spicy Tuna Roll from Sakura Sushi, so the cart holds only that roll. Do not check out.",
    inputs: { query: "Sakura Sushi" },
    start: "/eats/",
    maxSteps: 20,
    obstacles: ["one-restaurant cart rule dialog"],
    seed: (s) => {
      seededAddress(s)
      s.eats.promoDismissed = true
      s.eats.cart.push({ restaurantId: "tonys-slice", itemId: "pepperoni", qty: 1, options: { size: ["Medium 12\""] } })
    },
    milestones: [
      { name: "opened Sakura Sushi", reached: (s) => has(s, "eats:view-store", (d) => d.restaurant === "sakura") },
      { name: "saw the new-order prompt", reached: (s) => has(s, "eats:cart-conflict") },
      { name: "replaced the cart", reached: (s) => has(s, "eats:cart-replaced") },
    ],
    grade: (s) => eatsCartIs(s, "sakura", "spicy-tuna", 1, {}),
  },
]

/** The first milestone not reached, or the final check when every milestone was reached. */
export function progressOf(task: GauntletTask, s: RunState) {
  const reached = task.milestones.filter((m) => m.reached(s)).map((m) => m.name)
  const firstMissing = task.milestones.find((m) => !m.reached(s))
  return { reached, failedAt: firstMissing?.name ?? "final state check" }
}
