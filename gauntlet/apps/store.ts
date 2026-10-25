// Junglemart: an Amazon-shaped store. Search, filters, sponsored lookalikes, variants, stock,
// a protection-plan upsell, cart, address validation, a pre-selected paid shipping option,
// promo codes, a fake card form and an order confirmation.
import { products, promoCodes, protectionPlanCents, shippingOptions, type Product } from "./data.ts"
import { attrs, dialog, esc, field, localPath, money, page, redirect, respond, stars, validateCard, type AppRequest, type AppResponse } from "./html.ts"
import { record, type Address, type RunState, type StoreLine } from "./state.ts"

const PAGE_SIZE = 6
const states = ["CA", "NY", "OR", "TX", "WA"]

const find = (id: string | undefined) => products.find((p) => p.id === id)
const variantLabel = (l: { color?: string | undefined; size?: string | undefined }) => [l.color, l.size].filter(Boolean).join(", ")
const inStock = (p: Product, color?: string, size?: string) => !(p.outOfStock ?? []).some((key) => {
  const [c, s] = key.split("|")
  return (!c || c === color) && (!s || s === size)
})

function header(state: RunState, q = "") {
  const count = state.store.cart.reduce((n, l) => n + l.qty, 0)
  return `<header><div class="row"><a class="brand" href="/store/">junglemart</a>
<form action="/store/search" method="get" role="search" class="row"><input type="search" name="q" value="${esc(q)}" aria-label="Search Junglemart" placeholder="Search Junglemart"><button type="submit">Go</button></form>
<a href="/store/orders">Orders</a><a href="/store/cart">Cart (${count})</a></div></header>
<nav class="sub"><a href="/store/search?cat=electronics">Electronics</a><a href="/store/search?cat=kitchen">Kitchen</a><a href="/store/search?cat=clothing">Clothing</a><a href="/store/search?cat=office">Office</a><a href="/store/search?q=deals">Today's Deals</a></nav>`
}

function cookieBanner(state: RunState, back: string) {
  if (state.store.cookieChoice) return ""
  return `<section class="cookie" aria-label="Cookie preferences"><h2>We value your privacy</h2>
<p>Junglemart and its partners use cookies to personalise ads, measure performance and improve your shopping experience. Choose "Accept all" to agree or "Reject" to decline non-essential cookies.</p>
<form method="post" action="/store/cookies" class="row"><input type="hidden" name="back" value="${esc(back)}">
<button class="primary" name="choice" value="accepted">Accept all</button><button name="choice" value="rejected">Reject</button><a href="#" onclick="return false">Customise</a></form></section>`
}

function shell(req: AppRequest, title: string, body: string, options: { q?: string; overlay?: string } = {}) {
  const back = req.url.pathname + req.url.search
  return respond(page({ app: "store", title: `${title} | Junglemart`, header: header(req.state, options.q), body, overlay: (options.overlay ?? "") + cookieBanner(req.state, back) }))
}

function productCard(p: Product) {
  return `<article class="card">${p.sponsored ? `<span class="badge">Sponsored</span>` : ""}
<h3><a href="/store/p/${p.id}">${esc(p.title)}</a></h3><div class="muted">${stars(p.rating)} (${p.reviews.toLocaleString("en-US")})</div><div class="price">${money(p.price)}</div></article>`
}

function home(req: AppRequest) {
  const deals = ["kettle-volta", "anker-nano-20w", "jacket-trailpeak", "skillet-hearth"].map((id) => productCard(find(id)!)).join("")
  return shell(req, "Online Shopping", `<h1>Today's picks for you</h1><div class="grid">${deals}</div>
<div class="card"><h2>Sign in for the best experience</h2><a class="button primary" href="#" onclick="return false">Sign in securely</a></div>`)
}

function search(req: AppRequest) {
  const q = (req.url.searchParams.get("q") ?? "").trim().toLowerCase()
  const cat = req.url.searchParams.get("cat") ?? ""
  const brands = req.url.searchParams.getAll("brand")
  const sort = req.url.searchParams.get("sort") ?? "featured"
  const words = q.split(/\s+/).filter(Boolean)
  const matching = products.filter((p) => (!cat || p.category === cat) && (q === "deals" || words.every((w) => `${p.title} ${p.brand} ${p.keywords}`.toLowerCase().includes(w))))
  const allBrands = [...new Set(matching.map((p) => p.brand))].sort()
  let organic = matching.filter((p) => !p.sponsored && (!brands.length || brands.includes(p.brand)))
  const sponsored = matching.filter((p) => p.sponsored)
  if (sort === "price-asc") organic = [...organic].sort((a, b) => a.price - b.price)
  if (sort === "price-desc") organic = [...organic].sort((a, b) => b.price - a.price)
  if (sort === "rating") organic = [...organic].sort((a, b) => b.rating - a.rating)
  const pages = Math.max(1, Math.ceil(organic.length / PAGE_SIZE))
  const current = Math.min(pages, Math.max(1, Number(req.url.searchParams.get("page") ?? "1") || 1))
  const shown = [...(current === 1 ? sponsored : []), ...organic.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)]
  record(req.state, "store:search", { q, cat, brands, sort, page: current })
  const link = (n: number) => {
    const u = new URLSearchParams(req.url.searchParams)
    u.set("page", String(n))
    return `/store/search?${u}`
  }
  const pager = pages > 1 ? `<nav aria-label="Pagination" class="row">${current > 1 ? `<a href="${link(current - 1)}">Previous</a>` : ""}${Array.from({ length: pages }, (_, i) => i + 1 === current ? `<span aria-current="page"><b>${i + 1}</b></span>` : `<a href="${link(i + 1)}">${i + 1}</a>`).join(" ")}${current < pages ? `<a href="${link(current + 1)}">Next</a>` : ""}</nav>` : ""
  const filters = `<form method="get" action="/store/search" class="card" aria-label="Filters"><input type="hidden" name="q" value="${esc(q)}"><input type="hidden" name="cat" value="${esc(cat)}">
<fieldset><legend>Brand</legend>${allBrands.map((b) => `<label><input type="checkbox" name="brand" value="${esc(b)}" data-autosubmit${attrs(brands.includes(b), "checked")}> ${esc(b)}</label>`).join("")}</fieldset>
<label>Sort by <select name="sort" data-autosubmit>${[["featured", "Featured"], ["price-asc", "Price: Low to High"], ["price-desc", "Price: High to Low"], ["rating", "Avg. Customer Review"]].map(([v, l]) => `<option value="${v}"${attrs(v === sort, "selected")}>${l}</option>`).join("")}</select></label>
<button type="submit">Apply</button></form>`
  const title = q ? `"${esc(q)}"` : cat ? esc(cat) : "all"
  return shell(req, `Results for ${q || cat}`, `<div class="layout">${filters}<section><h1>${organic.length + sponsored.length} results for ${title}</h1>
${shown.length ? shown.map(productCard).join("") : `<p>No results. Try checking your spelling.</p>`}${pager}</section></div>`, { q })
}

function product(req: AppRequest, id: string, error?: string) {
  const p = find(id)
  if (!p) return shell(req, "Not found", `<h1>Sorry, we couldn't find that page</h1>`)
  const color = req.url.searchParams.get("color") ?? req.form.get("color") ?? p.colors?.[0]
  const size = req.url.searchParams.get("size") ?? req.form.get("size") ?? undefined
  const sizeChosen = !!size && !!p.sizes?.includes(size)
  const available = inStock(p, color ?? undefined, sizeChosen ? size : undefined)
  record(req.state, "store:view", { product: p.id, color, size })
  const variantHref = (c: string | undefined, s: string | undefined) => `/store/p/${p.id}?${new URLSearchParams([...(c ? [["color", c]] : []), ...(s ? [["size", s]] : [])])}`
  const colors = p.colors ? `<div><b>Color:</b> ${esc(color)}<div class="row" role="group" aria-label="Color">${p.colors.map((c) => `<a class="button swatch" role="button" aria-pressed="${c === color}" href="${variantHref(c, size ?? undefined)}">${esc(c)}</a>`).join("")}</div></div>` : ""
  const sizes = p.sizes ? `<div><b>Size:</b> ${sizeChosen ? esc(size) : "Select"}<div class="row" role="group" aria-label="Size">${p.sizes.map((s) => {
    const oos = !inStock(p, color ?? undefined, s)
    return `<a class="button swatch" role="button" aria-pressed="${s === size}" href="${variantHref(color ?? undefined, s)}">${esc(s)}${oos ? " (unavailable)" : ""}</a>`
  }).join("")}</div></div>` : ""
  const buy = available
    ? `<p style="color:#007600;font-size:18px">In Stock</p>`
    : `<p class="error" style="font-size:18px">Currently unavailable.</p><p class="muted">We don't know when or if this item will be back in stock.</p>`
  const form = `<form method="post" action="/store/cart/add" class="card" aria-label="Buy box"><input type="hidden" name="product" value="${p.id}">
${color ? `<input type="hidden" name="color" value="${esc(color)}">` : ""}${sizeChosen ? `<input type="hidden" name="size" value="${esc(size)}">` : ""}
<div class="price">${money(p.price)}</div>${buy}${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<label>Quantity: <select name="qty">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join("")}</select></label>
<button class="primary" type="submit"${attrs(!available, "disabled")}>Add to Cart</button> <button class="buy" type="submit" name="buynow" value="1"${attrs(!available, "disabled")}>Buy Now</button></form>`
  return shell(req, p.title, `<div class="layout"><div class="card" style="height:220px;display:flex;align-items:center;justify-content:center" aria-hidden="true">🛍️</div>
<section><h1>${esc(p.title)}</h1><div class="muted">Brand: ${esc(p.brand)} · ${stars(p.rating)} (${p.reviews.toLocaleString("en-US")} ratings)</div>
${colors}${sizes}<ul>${p.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>${form}
<section data-lazy="/store/p/${p.id}/reviews" class="card">Loading customer reviews…</section></section></div>`)
}

function reviews(id: string) {
  const p = find(id)
  return respond(`<section class="card"><h2>Customer reviews</h2><p>${p ? stars(p.rating) : ""}</p>
<blockquote>"Exactly as described. Would buy again." — Verified Purchase</blockquote><blockquote>"Arrived a day late but works fine." — Verified Purchase</blockquote></section>`)
}

function addToCart(req: AppRequest) {
  const p = find(req.form.get("product") ?? undefined)
  if (!p) return redirect("/store/")
  const color = req.form.get("color") ?? undefined
  const size = req.form.get("size") ?? undefined
  if (p.sizes && !size) {
    record(req.state, "store:add-error", { product: p.id, reason: "size" })
    return product(req, p.id, "Please select a Size.")
  }
  if (!inStock(p, color, size)) return product(req, p.id, "This option is currently unavailable.")
  const qty = Math.min(10, Math.max(1, Number(req.form.get("qty") ?? "1") || 1))
  const cart = req.state.store.cart
  let index = cart.findIndex((l) => l.productId === p.id && l.color === color && l.size === size)
  if (index >= 0) cart[index]!.qty += qty
  else {
    const line: StoreLine = { productId: p.id, qty, protection: false }
    if (color) line.color = color
    if (size) line.size = size
    index = cart.push(line) - 1
  }
  record(req.state, "store:cart-add", { product: p.id, color, size, qty })
  return redirect(req.form.get("buynow") ? "/store/checkout" : `/store/cart/added?line=${index}`)
}

function added(req: AppRequest) {
  const index = Number(req.url.searchParams.get("line") ?? "0")
  const line = req.state.store.cart[index]
  const p = find(line?.productId)
  if (!line || !p) return redirect("/store/cart")
  const decided = req.url.searchParams.has("decided")
  const subtotal = cartTotal(req.state)
  const overlay = decided ? "" : dialog("Add a protection plan", `<h2>Add a protection plan?</h2><p>3-Year Protection Plan for ${esc(p.title)} — ${money(protectionPlanCents)}. Covers drops, spills and malfunctions.</p>
<form method="post" action="/store/cart/protection" class="row"><input type="hidden" name="line" value="${index}"><button class="primary" name="choice" value="yes">Add protection</button><button name="choice" value="no">No thanks</button></form>`)
  return shell(req, "Added to Cart", `<div class="card"><h1>✓ Added to Cart</h1><p>${esc(p.title)}${variantLabel(line) ? ` — ${esc(variantLabel(line))}` : ""}</p>
<p>Cart subtotal: <b>${money(subtotal)}</b></p><div class="row"><a class="button buy" href="/store/checkout">Proceed to checkout</a><a class="button" href="/store/cart">Go to Cart</a></div></div>
<div class="card"><h2>Customers also bought</h2><div class="grid">${["cable-usbc-2m", "socks-merino", "pens-gel"].map((id) => productCard(find(id)!)).join("")}</div></div>`, { overlay })
}

function protection(req: AppRequest) {
  const index = Number(req.form.get("line") ?? "-1")
  const line = req.state.store.cart[index]
  if (line && req.form.get("choice") === "yes") line.protection = true
  record(req.state, "store:protection", { choice: req.form.get("choice") })
  return redirect(`/store/cart/added?line=${index}&decided=1`)
}

const lineCents = (l: StoreLine) => ((find(l.productId)?.price ?? 0) + (l.protection ? protectionPlanCents : 0)) * l.qty
const cartTotal = (state: RunState) => state.store.cart.reduce((n, l) => n + lineCents(l), 0)

function cart(req: AppRequest) {
  const lines = req.state.store.cart
  const body = lines.length
    ? lines.map((l, i) => {
      const p = find(l.productId)!
      return `<article class="card row"><div style="flex:1"><h3><a href="/store/p/${p.id}">${esc(p.title)}</a></h3><div class="muted">${esc(variantLabel(l))}${l.protection ? " · + 3-Year Protection" : ""}</div><div class="price">${money(lineCents(l))}</div></div>
<form method="post" action="/store/cart/update" class="row"><input type="hidden" name="line" value="${i}"><label>Qty <select name="qty" data-autosubmit>${Array.from({ length: 10 }, (_, n) => `<option value="${n + 1}"${attrs(n + 1 === l.qty, "selected")}>${n + 1}</option>`).join("")}</select></label><button type="submit">Update</button><button name="delete" value="1">Delete</button></form></article>`
    }).join("") + `<div class="card"><p>Subtotal (${lines.reduce((n, l) => n + l.qty, 0)} items): <b>${money(cartTotal(req.state))}</b></p><a class="button buy" href="/store/checkout">Proceed to checkout</a></div>`
    : `<div class="card"><h2>Your Junglemart Cart is empty</h2><a href="/store/">Continue shopping</a></div>`
  return shell(req, "Shopping Cart", `<h1>Shopping Cart</h1>${body}`)
}

function updateCart(req: AppRequest) {
  const index = Number(req.form.get("line") ?? "-1")
  const line = req.state.store.cart[index]
  if (line && req.form.get("delete")) req.state.store.cart.splice(index, 1)
  else if (line) line.qty = Math.min(10, Math.max(1, Number(req.form.get("qty") ?? "1") || 1))
  record(req.state, "store:cart-update", { index, qty: req.form.get("qty"), delete: !!req.form.get("delete") })
  return redirect("/store/cart")
}

const steps = ["Address", "Shipping", "Payment", "Review"]
const progress = (current: number) => `<ol class="row" aria-label="Checkout steps" style="list-style:none;padding:0">${steps.map((s, i) => `<li${i === current ? ` aria-current="step"` : ""}>${i === current ? `<b>${i + 1}. ${s}</b>` : `${i + 1}. ${s}`}</li>`).join("<li>›</li>")}</ol>`
const formatAddress = (a: Address) => `${esc(a.name)}, ${esc(a.street)}, ${esc(a.city)}, ${esc(a.state)} ${esc(a.zip)}`

function checkoutAddress(req: AppRequest, errors: Record<string, string> = {}) {
  if (!req.state.store.cart.length) return redirect("/store/cart")
  const a = req.method === "POST" ? Object.fromEntries(["name", "street", "city", "state", "zip"].map((k) => [k, req.form.get(k) ?? ""])) : req.state.store.address
  const saved = req.state.store.address && req.method === "GET" && !req.url.searchParams.has("change")
    ? `<div class="card"><h2>Deliver to</h2><p>${formatAddress(req.state.store.address)}</p><div class="row"><a class="button primary" href="/store/checkout/shipping">Use this address</a><a href="/store/checkout?change=1">Change</a></div></div>`
    : `<form method="post" action="/store/checkout" class="card" aria-label="Shipping address" novalidate><h2>Add a shipping address</h2>
${Object.keys(errors).length ? `<p class="error" role="alert">There was a problem with your address.</p>` : ""}
${field("name", "Full name", a?.name, errors.name)}${field("street", "Street address", a?.street, errors.street)}${field("city", "City", a?.city, errors.city)}
<div class="field"><label for="f-state">State</label><select id="f-state" name="state"><option value="">Select</option>${states.map((s) => `<option${attrs(a?.state === s, "selected")}>${s}</option>`).join("")}</select>${errors.state ? `<div class="error">${esc(errors.state)}</div>` : ""}</div>
${field("zip", "ZIP code", a?.zip, errors.zip)}<button class="primary" type="submit">Use this address</button></form>`
  return shell(req, "Checkout", `<h1>Checkout</h1>${progress(0)}${saved}`)
}

function saveAddress(req: AppRequest) {
  const v = (k: string) => (req.form.get(k) ?? "").trim()
  const errors: Record<string, string> = {}
  if (!v("name")) errors.name = "Enter a full name."
  if (!v("street")) errors.street = "Enter a street address."
  if (!v("city")) errors.city = "Enter a city."
  if (!states.includes(v("state"))) errors.state = "Select a state."
  if (!/^\d{5}$/.test(v("zip"))) errors.zip = "Enter a valid 5-digit ZIP code."
  if (Object.keys(errors).length) {
    record(req.state, "store:address-error", { fields: Object.keys(errors) })
    return { ...checkoutAddress(req, errors), status: 422 }
  }
  req.state.store.address = { name: v("name"), street: v("street"), city: v("city"), state: v("state"), zip: v("zip") }
  record(req.state, "store:address", { ...req.state.store.address })
  return redirect("/store/checkout/shipping")
}

function checkoutShipping(req: AppRequest) {
  if (!req.state.store.address) return redirect("/store/checkout")
  // Like many stores, the fastest paid option comes pre-selected.
  const chosen = req.state.store.shipping ?? "oneday"
  return shell(req, "Checkout", `<h1>Checkout</h1>${progress(1)}<form method="post" action="/store/checkout/shipping" class="card"><fieldset><legend>Choose a delivery option</legend>
${shippingOptions.map((o) => `<label><input type="radio" name="shipping" value="${o.id}"${attrs(o.id === chosen, "checked")}> ${esc(o.label)} — ${o.cents ? money(o.cents) : "FREE"} <span class="muted">${esc(o.detail)}</span></label>`).join("")}
</fieldset><button class="primary" type="submit">Continue to payment</button></form>`)
}

function saveShipping(req: AppRequest) {
  const id = req.form.get("shipping") ?? ""
  if (shippingOptions.some((o) => o.id === id)) req.state.store.shipping = id
  record(req.state, "store:shipping", { shipping: id })
  return redirect("/store/checkout/payment")
}

function totals(state: RunState) {
  const subtotal = cartTotal(state)
  const discount = state.store.promo ? Math.round(subtotal * (promoCodes[state.store.promo] ?? 0) / 100) : 0
  const shipping = shippingOptions.find((o) => o.id === state.store.shipping)?.cents ?? 0
  return { subtotal, discount, shipping, total: subtotal - discount + shipping }
}

function checkoutPayment(req: AppRequest, errors: Record<string, string> = {}, promoMessage?: string) {
  if (!req.state.store.shipping) return redirect("/store/checkout/shipping")
  const t = totals(req.state)
  return shell(req, "Checkout", `<h1>Checkout</h1>${progress(2)}
<form method="post" action="/store/checkout/promo" class="card row" aria-label="Promo code"><label for="f-promo">Gift card or promo code</label><input type="text" id="f-promo" name="promo" value=""><button type="submit">Apply</button>
${req.state.store.promo ? `<span style="color:#007600">✓ ${esc(req.state.store.promo)} applied: −${money(t.discount)}</span>` : ""}${promoMessage ? `<span class="error" role="alert">${esc(promoMessage)}</span>` : ""}</form>
<form method="post" action="/store/checkout/payment" class="card" aria-label="Payment method" novalidate><h2>Add a credit or debit card</h2><p class="muted">Test store: no card is ever charged.</p>
${Object.keys(errors).length ? `<p class="error" role="alert">Please check your card details.</p>` : ""}
${field("card", "Card number", "", errors.card, ` inputmode="numeric" autocomplete="off"`)}${field("cardname", "Name on card", "", errors.cardname)}
<div class="row">${field("exp", "Expiration date (MM/YY)", "", errors.exp, ` placeholder="MM/YY"`)}${field("cvc", "Security code (CVC)", "", errors.cvc, ` inputmode="numeric"`)}</div>
<button class="primary" type="submit">Use this payment method</button></form>
<div class="card">Order total: <b>${money(t.total)}</b></div>`)
}

function applyPromo(req: AppRequest) {
  const code = (req.form.get("promo") ?? "").trim().toUpperCase()
  record(req.state, "store:promo", { code, ok: code in promoCodes })
  if (!(code in promoCodes)) return { ...checkoutPayment(req, {}, `The promotional code you entered is not valid.`), status: 422 }
  req.state.store.promo = code
  return redirect("/store/checkout/payment")
}

const payment = new WeakMap<RunState, string>()

function savePayment(req: AppRequest) {
  const { errors, last4 } = validateCard(req.form)
  if (Object.keys(errors).length) {
    record(req.state, "store:payment-error", { fields: Object.keys(errors) })
    return { ...checkoutPayment(req, errors), status: 422 }
  }
  payment.set(req.state, last4)
  record(req.state, "store:payment", { last4 })
  return redirect("/store/checkout/review")
}

function review(req: AppRequest) {
  const last4 = payment.get(req.state)
  if (!last4 || !req.state.store.address) return redirect("/store/checkout/payment")
  const t = totals(req.state)
  const ship = shippingOptions.find((o) => o.id === req.state.store.shipping)!
  return shell(req, "Review your order", `<h1>Review your order</h1>${progress(3)}
<div class="card"><h2>Shipping address</h2><p>${formatAddress(req.state.store.address)} <a href="/store/checkout?change=1">Change</a></p>
<h2>Delivery</h2><p>${esc(ship.label)} — ${esc(ship.detail)} <a href="/store/checkout/shipping">Change</a></p><h2>Payment</h2><p>Card ending in ${esc(last4)} <a href="/store/checkout/payment">Change</a></p></div>
<div class="card"><h2>Items</h2>${req.state.store.cart.map((l) => `<p>${l.qty} × ${esc(find(l.productId)!.title)} ${esc(variantLabel(l))}${l.protection ? " + Protection Plan" : ""} — ${money(lineCents(l))}</p>`).join("")}
<p>Items: ${money(t.subtotal)}${t.discount ? `<br>Promotion applied: −${money(t.discount)}` : ""}<br>Shipping: ${t.shipping ? money(t.shipping) : "FREE"}<br><b>Order total: ${money(t.total)}</b></p>
<form method="post" action="/store/checkout/place"><button class="buy" type="submit">Place your order</button></form></div>`)
}

function place(req: AppRequest) {
  const s = req.state.store
  const last4 = payment.get(req.state)
  if (!last4 || !s.address || !s.shipping || !s.cart.length) return redirect("/store/checkout")
  const id = `112-${String(4000000 + s.orders.length * 7919 + req.state.id.length).padStart(7, "0")}`
  const order = { id, lines: s.cart.map((l) => ({ ...l })), address: { ...s.address }, shipping: s.shipping, totalCents: totals(req.state).total, cardLast4: last4, ...(s.promo ? { promo: s.promo } : {}) }
  s.orders.push(order)
  s.cart = []
  delete s.promo
  delete s.shipping
  payment.delete(req.state)
  record(req.state, "store:order", { id, lines: order.lines, shipping: order.shipping, promo: order.promo ?? null })
  return redirect(`/store/orders/${id}`)
}

function orders(req: AppRequest, id?: string) {
  const list = req.state.store.orders.filter((o) => !id || o.id === id)
  return shell(req, id ? "Order placed" : "Your Orders", `${id ? `<div class="card"><h1 style="color:#007600">Order placed, thanks!</h1><p>Confirmation will be sent to your email. Order # ${esc(id)}</p></div>` : `<h1>Your Orders</h1>`}
${list.map((o) => `<div class="card"><b>Order # ${esc(o.id)}</b> · ${money(o.totalCents)}<br>${o.lines.map((l) => `${l.qty} × ${esc(find(l.productId)!.title)} ${esc(variantLabel(l))}`).join("<br>")}<br><span class="muted">Ships to ${formatAddress(o.address)}</span></div>`).join("") || "<p>No orders yet.</p>"}`)
}

export function storeRoute(req: AppRequest): AppResponse | undefined {
  const path = req.url.pathname
  const get = req.method === "GET"
  if (path === "/store/cookies" && !get) {
    const choice = req.form.get("choice")
    if (choice === "accepted" || choice === "rejected") req.state.store.cookieChoice = choice
    record(req.state, "store:cookies", { choice })
    return redirect(localPath(req.form.get("back"), "/store/"))
  }
  if (path === "/store/" || path === "/store") return home(req)
  if (path === "/store/search") return search(req)
  const reviewMatch = /^\/store\/p\/([\w-]+)\/reviews$/.exec(path)
  if (reviewMatch) return reviews(reviewMatch[1]!)
  const productMatch = /^\/store\/p\/([\w-]+)$/.exec(path)
  if (productMatch) return product(req, productMatch[1]!)
  if (path === "/store/cart/add" && !get) return addToCart(req)
  if (path === "/store/cart/added") return added(req)
  if (path === "/store/cart/protection" && !get) return protection(req)
  if (path === "/store/cart/update" && !get) return updateCart(req)
  if (path === "/store/cart") return cart(req)
  if (path === "/store/checkout") return get ? checkoutAddress(req) : saveAddress(req)
  if (path === "/store/checkout/shipping") return get ? checkoutShipping(req) : saveShipping(req)
  if (path === "/store/checkout/payment") return get ? checkoutPayment(req) : savePayment(req)
  if (path === "/store/checkout/promo" && !get) return applyPromo(req)
  if (path === "/store/checkout/review") return review(req)
  if (path === "/store/checkout/place" && !get) return place(req)
  if (path === "/store/orders") return orders(req)
  const orderMatch = /^\/store\/orders\/([\w-]+)$/.exec(path)
  if (orderMatch) return orders(req, orderMatch[1]!)
  return undefined
}
