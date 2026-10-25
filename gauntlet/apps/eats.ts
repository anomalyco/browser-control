// Grubber: an Uber Eats-shaped delivery app. An address gate, a membership promo modal, closed
// restaurants, sold-out items, required item options, a lazily loaded menu section, the
// one-restaurant cart rule, a pre-checkout upsell, a pre-checked membership box, tips and a fake card.
import { membershipCents, restaurants, type MenuItem, type Restaurant } from "./data.ts"
import { attrs, dialog, esc, field, fragment, localPath, money, page, redirect, respond, validateCard, type AppRequest, type AppResponse } from "./html.ts"
import { record, type EatsLine, type EatsOrder, type RunState } from "./state.ts"

const tips = [0, 10, 15, 18, 20]
const findRestaurant = (id: string | null | undefined) => restaurants.find((r) => r.id === id)
const findItem = (r: Restaurant | undefined, id: string | null | undefined) => r?.sections.flatMap((s) => s.items).find((i) => i.id === id)

function header(state: RunState) {
  const count = state.eats.cart.reduce((n, l) => n + l.qty, 0)
  return `<header><div class="row"><a class="brand" href="/eats/">Grubber</a><a href="/eats/address?back=${encodeURIComponent("/eats/")}">📍 ${esc(state.eats.address ?? "Set delivery address")}</a>
<form action="/eats/search" method="get" role="search" class="row"><input type="search" name="q" aria-label="Search Grubber" placeholder="Food, groceries, drinks, etc"><button type="submit">Search</button></form>
<a href="/eats/orders">Orders</a><a href="/eats/cart">🛒 Cart · ${count}</a></div></header>`
}

function shell(req: AppRequest, title: string, body: string, overlay = "") {
  return respond(page({ app: "eats", title: `${title} · Grubber`, header: header(req.state), body, overlay }))
}

const lineCents = (l: EatsLine) => {
  const item = findItem(findRestaurant(l.restaurantId), l.itemId)
  if (!item) return 0
  const extras = (item.groups ?? []).reduce((n, g) => n + g.choices.filter((c) => l.options[g.id]?.includes(c.name)).reduce((m, c) => m + c.cents, 0), 0)
  return (item.cents + extras) * l.qty
}
const subtotal = (state: RunState) => state.eats.cart.reduce((n, l) => n + lineCents(l), 0)

function restaurantCard(r: Restaurant) {
  return `<article class="card${r.open ? "" : " closed"}"><h3><a href="/eats/store/${r.id}">${esc(r.name)}</a></h3>
<div class="muted">${esc(r.cuisine)} · ★ ${r.rating.toFixed(1)} · ${esc(r.eta)} · ${money(r.fee)} delivery fee</div>${r.open ? "" : `<span class="badge">Closed</span>`}</article>`
}

function addressGate(req: AppRequest, error?: string) {
  const back = localPath(req.url.searchParams.get("back") ?? req.form.get("back"), "/eats/")
  return dialog("Enter your delivery address", `<h2>Where should we deliver?</h2><p class="muted">Enter an address to see restaurants near you.</p>
<form method="post" action="/eats/address"><input type="hidden" name="back" value="${esc(back)}">${field("address", "Delivery address", req.form.get("address") ?? "", error, ` placeholder="Street, city, ZIP"`)}
<button class="primary" type="submit">Save address</button></form>`)
}

function promoModal() {
  return dialog("Grubber One", `<h2>Try Grubber One free for 30 days</h2><p>$0 delivery fee and 5% off eligible orders. ${money(membershipCents)}/month after your trial. Cancel anytime.</p>
<form method="post" action="/eats/promo" class="row"><button class="primary" name="choice" value="trial">Start free trial</button><button name="choice" value="dismiss">Not now</button></form>`)
}

function feed(req: AppRequest, list: readonly Restaurant[], heading: string) {
  const overlay = !req.state.eats.address ? addressGate(req) : !req.state.eats.promoDismissed ? promoModal() : ""
  const cuisines = [...new Set(restaurants.map((r) => r.cuisine))]
  return shell(req, heading, `<div class="row" aria-label="Cuisines">${cuisines.map((c) => `<a class="chip" href="/eats/search?cuisine=${encodeURIComponent(c)}">${esc(c)}</a>`).join("")}</div>
<h1>${esc(heading)}</h1>${list.length ? `<div class="grid">${list.map(restaurantCard).join("")}</div>` : `<p>No results. Try another search.</p>`}`, overlay)
}

function search(req: AppRequest) {
  const q = (req.url.searchParams.get("q") ?? "").trim().toLowerCase()
  const cuisine = req.url.searchParams.get("cuisine") ?? ""
  const words = q.split(/\s+/).filter(Boolean)
  const list = restaurants.filter((r) => (!cuisine || r.cuisine === cuisine) && words.every((w) => `${r.name} ${r.cuisine} ${r.keywords} ${r.sections.flatMap((s) => s.items.map((i) => i.name)).join(" ")}`.toLowerCase().includes(w)))
  record(req.state, "eats:search", { q, cuisine })
  return feed(req, list, q ? `Results for "${q}"` : `${cuisine || "All"} near you`)
}

function menuItem(r: Restaurant, item: MenuItem) {
  const unavailable = item.soldOut || !r.open
  const name = unavailable ? `<b>${esc(item.name)}</b>` : `<a href="/eats/store/${r.id}/item/${item.id}"><b>${esc(item.name)}</b></a>`
  return `<li class="menu-item"><div>${name}<div class="muted">${esc(item.description)}</div></div><div>${money(item.cents)}${item.soldOut ? ` <span class="badge">Sold out</span>` : ""}</div></li>`
}

function section(r: Restaurant, s: Restaurant["sections"][number]) {
  return `<section aria-label="${esc(s.name)}"><h2>${esc(s.name)}</h2><ul style="list-style:none;padding:0">${s.items.map((i) => menuItem(r, i)).join("")}</ul></section>`
}

function storePage(req: AppRequest, r: Restaurant) {
  record(req.state, "eats:view-store", { restaurant: r.id })
  const sections = r.sections.map((s) => s.lazy ? `<section data-lazy="/eats/store/${r.id}/section/${encodeURIComponent(s.name)}" class="muted" style="min-height:200px">Loading more of the menu…</section>` : section(r, s)).join("")
  const overlay = !req.state.eats.address ? addressGate(req) : ""
  const added = findItem(r, req.url.searchParams.get("added"))
  return shell(req, r.name, `${added ? `<p class="card" role="status">✓ Added ${esc(added.name)} to your cart. <a href="/eats/cart">View cart</a></p>` : ""}<div class="card"><h1>${esc(r.name)}</h1><div class="muted">${esc(r.cuisine)} · ★ ${r.rating.toFixed(1)} · ${esc(r.eta)}</div>
${r.open ? "" : `<p class="error" role="status">Closed right now · ${esc(r.eta)}. You can browse the menu but can't order.</p>`}</div>
<nav class="row" aria-label="Menu sections">${r.sections.map((s) => `<span class="chip">${esc(s.name)}</span>`).join("")}</nav><div class="card">${sections}</div>`, overlay)
}

function itemPage(req: AppRequest, r: Restaurant, item: MenuItem, errors: Record<string, string> = {}, conflict?: Restaurant) {
  const chosen = (group: string) => req.form.getAll(`opt_${group}`)
  const groups = (item.groups ?? []).map((g) => `<fieldset${errors[g.id] ? ` aria-invalid="true"` : ""}><legend>${esc(g.label)} ${g.required ? `<span class="badge">Required</span>` : `<span class="muted">(optional, choose up to ${g.max})</span>`}</legend>
${errors[g.id] ? `<div class="error">${esc(errors[g.id])}</div>` : ""}${g.choices.map((c) => `<label><input type="${g.max === 1 ? "radio" : "checkbox"}" name="opt_${g.id}" value="${esc(c.name)}"${attrs(chosen(g.id).includes(c.name), "checked")}> ${esc(c.name)}${c.cents ? ` +${money(c.cents)}` : ""}</label>`).join("")}</fieldset>`).join("")
  const hidden = conflict ? [...req.form].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("") : ""
  const overlay = conflict ? dialog("Start a new order?", `<h2>Start a new order?</h2><p>Your cart has items from ${esc(conflict.name)}. Start a new order to add items from ${esc(r.name)} instead.</p>
<form method="post" action="/eats/cart/add" class="row">${hidden}<button class="primary" name="replace" value="1">New order</button><a class="button" href="/eats/store/${r.id}">Cancel</a></form>`) : ""
  const qty = Number(req.form.get("qty") ?? "1") || 1
  return shell(req, item.name, `<a href="/eats/store/${r.id}">← ${esc(r.name)}</a><form method="post" action="/eats/cart/add" class="card" aria-label="${esc(item.name)}" novalidate>
<h1>${esc(item.name)}</h1><p class="muted">${esc(item.description)}</p><p class="price">${money(item.cents)}</p>
${Object.keys(errors).length ? `<p class="error" role="alert">Make the required selections to continue.</p>` : ""}
<input type="hidden" name="restaurant" value="${r.id}"><input type="hidden" name="item" value="${item.id}">${groups}
<label for="f-note">Special instructions</label><textarea id="f-note" name="note" rows="2" style="width:100%">${esc(req.form.get("note") ?? "")}</textarea>
<label>Quantity <select name="qty">${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}"${attrs(n === qty, "selected")}>${n}</option>`).join("")}</select></label>
<button class="primary" type="submit">Add to order</button></form>`, overlay)
}

function addToCart(req: AppRequest) {
  const r = findRestaurant(req.form.get("restaurant"))
  const item = findItem(r, req.form.get("item"))
  if (!r || !item) return redirect("/eats/")
  if (!r.open || item.soldOut) return { ...itemPage(req, r, item, { _: "This item is unavailable right now." }), status: 409 }
  const options: Record<string, string[]> = {}
  const errors: Record<string, string> = {}
  for (const g of item.groups ?? []) {
    const picked = req.form.getAll(`opt_${g.id}`).filter((v) => g.choices.some((c) => c.name === v))
    if (g.required && picked.length === 0) errors[g.id] = "Required"
    if (picked.length > g.max) errors[g.id] = `Choose up to ${g.max}.`
    if (picked.length) options[g.id] = picked
  }
  if (Object.keys(errors).length) {
    record(req.state, "eats:add-error", { item: item.id, groups: Object.keys(errors) })
    return { ...itemPage(req, r, item, errors), status: 422 }
  }
  const other = req.state.eats.cart.find((l) => l.restaurantId !== r.id)
  if (other) {
    if (!req.form.get("replace")) {
      record(req.state, "eats:cart-conflict", { from: other.restaurantId, to: r.id })
      return itemPage(req, r, item, {}, findRestaurant(other.restaurantId))
    }
    req.state.eats.cart = []
    req.state.eats.upsellSeen = false
    record(req.state, "eats:cart-replaced", { from: other.restaurantId, to: r.id })
  }
  const qty = Math.min(10, Math.max(1, Number(req.form.get("qty") ?? "1") || 1))
  const note = (req.form.get("note") ?? "").trim()
  const line: EatsLine = { restaurantId: r.id, itemId: item.id, qty, options, ...(note ? { note } : {}) }
  req.state.eats.cart.push(line)
  record(req.state, "eats:cart-add", { ...line })
  return redirect(`/eats/store/${r.id}?added=${item.id}`)
}

function describeLine(l: EatsLine) {
  const item = findItem(findRestaurant(l.restaurantId), l.itemId)
  const opts = Object.values(l.options).flat().join(", ")
  return `${l.qty} × ${esc(item?.name)}${opts ? ` <span class="muted">(${esc(opts)})</span>` : ""}`
}

function cart(req: AppRequest) {
  const lines = req.state.eats.cart
  const r = findRestaurant(lines[0]?.restaurantId)
  return shell(req, "Cart", `<h1>Your cart${r ? ` · ${esc(r.name)}` : ""}</h1>${lines.length ? `<div class="card">${lines.map((l, i) => `<div class="row menu-item"><div style="flex:1">${describeLine(l)}</div><div>${money(lineCents(l))}</div>
<form method="post" action="/eats/cart/remove"><input type="hidden" name="line" value="${i}"><button type="submit" aria-label="Remove ${esc(findItem(r, l.itemId)?.name)}">Remove</button></form></div>`).join("")}
<p>Subtotal: <b>${money(subtotal(req.state))}</b></p><a class="button primary" href="/eats/checkout">Go to checkout</a> <a href="/eats/store/${r?.id}">Add items</a></div>` : `<div class="card"><p>Your cart is empty.</p><a href="/eats/">Find food</a></div>`}`)
}

function checkout(req: AppRequest, errors: Record<string, string> = {}) {
  const lines = req.state.eats.cart
  const r = findRestaurant(lines[0]?.restaurantId)
  if (!r) return redirect("/eats/cart")
  if (!req.state.eats.upsellSeen) {
    const addOn = r.sections.flatMap((s) => s.items).find((i) => !i.groups && !i.soldOut && !lines.some((l) => l.itemId === i.id))
    return shell(req, "Before you check out", `<div class="card"><h1>Complete your meal</h1>${addOn ? `<p>Customers often add <b>${esc(addOn.name)}</b> (${money(addOn.cents)}).</p>` : ""}
<form method="post" action="/eats/upsell" class="row">${addOn ? `<button name="add" value="${addOn.id}">Add ${esc(addOn.name)}</button>` : ""}<button class="primary" name="add" value="">No thanks, continue</button></form></div>`)
  }
  const mode = req.form.get("mode") ?? "delivery"
  const tip = Number(req.form.get("tip") ?? "15")
  const membership = req.method === "POST" ? req.form.has("membership") : true
  return shell(req, "Checkout", `<h1>Checkout · ${esc(r.name)}</h1><form method="post" action="/eats/checkout" class="card" aria-label="Checkout" novalidate>
${Object.keys(errors).length ? `<p class="error" role="alert">${esc(errors._ ?? "Please fix the highlighted fields.")}</p>` : ""}
<fieldset><legend>How do you want your order?</legend><label><input type="radio" name="mode" value="delivery"${attrs(mode === "delivery", "checked")}> Delivery to ${esc(req.state.eats.address ?? "(no address set)")}</label>
<label><input type="radio" name="mode" value="pickup"${attrs(mode === "pickup", "checked")}> Pickup at ${esc(r.name)}</label> <a href="/eats/address?back=${encodeURIComponent("/eats/checkout")}">Change address</a></fieldset>
<fieldset><legend>Order summary</legend>${lines.map((l) => `<div>${describeLine(l)} — ${money(lineCents(l))}</div>`).join("")}<div>Subtotal ${money(subtotal(req.state))}</div></fieldset>
<fieldset><legend>Courier tip (delivery only)</legend><div class="row">${tips.map((t) => `<label><input type="radio" name="tip" value="${t}"${attrs(t === tip, "checked")}> ${t ? `${t}%` : "No tip"}</label>`).join("")}</div></fieldset>
<label><input type="checkbox" name="membership" value="1"${attrs(membership, "checked")}> Add Grubber One for ${money(membershipCents)}/mo — $0 delivery fees on this order</label>
<fieldset><legend>Payment</legend><p class="muted">Test app: no card is ever charged.</p>${field("card", "Card number", "", errors.card, ` inputmode="numeric" autocomplete="off"`)}
<div class="row">${field("exp", "Expiry (MM/YY)", "", errors.exp, ` placeholder="MM/YY"`)}${field("cvc", "CVC", "", errors.cvc, ` inputmode="numeric"`)}</div></fieldset>
<button class="primary" type="submit">Place order</button></form>`)
}

function placeOrder(req: AppRequest) {
  const s = req.state.eats
  const r = findRestaurant(s.cart[0]?.restaurantId)
  if (!r || !s.upsellSeen) return redirect("/eats/checkout")
  const mode: EatsOrder["mode"] = req.form.get("mode") === "pickup" ? "pickup" : "delivery"
  const { errors, last4 } = validateCard(req.form)
  if (mode === "delivery" && !s.address) errors._ = "Add a delivery address or choose pickup."
  if (Object.keys(errors).length) {
    record(req.state, "eats:payment-error", { fields: Object.keys(errors) })
    return { ...checkout(req, errors), status: 422 }
  }
  const tipPercent = mode === "pickup" ? 0 : Math.max(0, Number(req.form.get("tip") ?? "0") || 0)
  const membership = req.form.has("membership")
  const items = subtotal(req.state)
  const id = `GR-${String(5000 + s.orders.length).padStart(5, "0")}`
  const order = { id, restaurantId: r.id, lines: s.cart.map((l) => ({ ...l, options: { ...l.options } })), mode, tipPercent, membership, cardLast4: last4,
    totalCents: items + Math.round(items * tipPercent / 100) + (mode === "delivery" && !membership ? r.fee : 0) + (membership ? membershipCents : 0), ...(mode === "delivery" && s.address ? { address: s.address } : {}) }
  s.orders.push(order)
  s.cart = []
  s.upsellSeen = false
  record(req.state, "eats:order", { id, restaurant: r.id, mode, tipPercent, membership, lines: order.lines })
  return redirect(`/eats/orders/${id}`)
}

function orders(req: AppRequest, id?: string) {
  const list = req.state.eats.orders.filter((o) => !id || o.id === id)
  return shell(req, "Orders", `${id ? `<div class="card"><h1>Order confirmed 🎉</h1><p>${esc(id)} · Preparing your order</p></div>` : "<h1>Orders</h1>"}
${list.map((o) => `<div class="card"><b>${esc(findRestaurant(o.restaurantId)?.name)}</b> · ${esc(o.id)} · ${o.mode} · ${money(o.totalCents)}<br>${o.lines.map(describeLine).join("<br>")}</div>`).join("") || "<p>No orders yet.</p>"}`)
}

export function eatsRoute(req: AppRequest): AppResponse | undefined {
  const path = req.url.pathname
  const get = req.method === "GET"
  if (path === "/eats/" || path === "/eats") return feed(req, restaurants, "All stores near you")
  if (path === "/eats/address") {
    if (get) return shell(req, "Delivery address", "", addressGate(req))
    const address = (req.form.get("address") ?? "").trim()
    if (address.length < 8 || !/\d/.test(address)) {
      record(req.state, "eats:address-error", { address })
      return { ...shell(req, "Delivery address", "", addressGate(req, "Enter a full street address, including the number.")), status: 422 }
    }
    req.state.eats.address = address
    record(req.state, "eats:address", { address })
    return redirect(localPath(req.form.get("back"), "/eats/"))
  }
  if (path === "/eats/promo" && !get) {
    req.state.eats.promoDismissed = true
    record(req.state, "eats:promo", { choice: req.form.get("choice") })
    return redirect("/eats/")
  }
  if (path === "/eats/search") return search(req)
  const sectionMatch = /^\/eats\/store\/([\w-]+)\/section\/(.+)$/.exec(path)
  if (sectionMatch) {
    const r = findRestaurant(sectionMatch[1])
    const s = r?.sections.find((x) => x.name === decodeURIComponent(sectionMatch[2]!))
    return r && s ? fragment(section(r, s)) : fragment("")
  }
  const itemMatch = /^\/eats\/store\/([\w-]+)\/item\/([\w-]+)$/.exec(path)
  if (itemMatch) {
    const r = findRestaurant(itemMatch[1])
    const item = findItem(r, itemMatch[2])
    if (r && item && r.open && !item.soldOut) return itemPage(req, r, item)
    return redirect(r ? `/eats/store/${r.id}` : "/eats/")
  }
  const storeMatch = /^\/eats\/store\/([\w-]+)$/.exec(path)
  if (storeMatch) {
    const r = findRestaurant(storeMatch[1])
    return r ? storePage(req, r) : redirect("/eats/")
  }
  if (path === "/eats/cart/add" && !get) return addToCart(req)
  if (path === "/eats/cart/remove" && !get) {
    req.state.eats.cart.splice(Number(req.form.get("line") ?? "-1"), 1)
    record(req.state, "eats:cart-remove", { line: req.form.get("line") })
    return redirect("/eats/cart")
  }
  if (path === "/eats/cart") return cart(req)
  if (path === "/eats/upsell" && !get) {
    const r = findRestaurant(req.state.eats.cart[0]?.restaurantId)
    const addOn = findItem(r, req.form.get("add"))
    if (r && addOn) req.state.eats.cart.push({ restaurantId: r.id, itemId: addOn.id, qty: 1, options: {} })
    req.state.eats.upsellSeen = true
    record(req.state, "eats:upsell", { added: addOn?.id ?? null })
    return redirect("/eats/checkout")
  }
  if (path === "/eats/checkout") return get ? checkout(req) : placeOrder(req)
  if (path === "/eats/orders") return orders(req)
  const orderMatch = /^\/eats\/orders\/([\w-]+)$/.exec(path)
  if (orderMatch) return orders(req, orderMatch[1]!)
  return undefined
}
