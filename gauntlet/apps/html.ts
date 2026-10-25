import type { RunState } from "./state.ts"

export type AppRequest = {
  readonly method: string
  readonly url: URL
  readonly form: URLSearchParams
  readonly state: RunState
}

export type AppResponse = { readonly status: number; readonly headers?: Record<string, string>; readonly body?: string }

export const respond = (body: string, status = 200): AppResponse => ({ status, headers: { "content-type": "text/html; charset=utf-8" }, body })
export const redirect = (location: string): AppResponse => ({ status: 303, headers: { location } })
export const fragment = (body: string): AppResponse => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body })

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
export const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => entities[c] ?? c)
export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`
export const stars = (rating: number) => `${"★".repeat(Math.round(rating))}${"☆".repeat(5 - Math.round(rating))} ${rating.toFixed(1)}`
export const attrs = (on: boolean, attr: string) => (on ? ` ${attr}` : "")

/** Same-app paths only, so a `back` field can never redirect off the fixture. */
export function localPath(value: string | null | undefined, fallback: string) {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : fallback
}

const base = `*{box-sizing:border-box}body{margin:0;font:15px/1.45 -apple-system,system-ui,sans-serif;color:#111;background:#f3f3f3}
a{color:#0a58ca}main{max-width:1080px;margin:0 auto;padding:16px}h1{font-size:24px;margin:8px 0 12px}h2{font-size:19px}
button,.button{font:inherit;border:1px solid #999;border-radius:8px;padding:7px 14px;background:#fff;cursor:pointer;text-decoration:none;color:#111;display:inline-block}
button:disabled{opacity:.45;cursor:not-allowed}input[type=text],input[type=search],select,textarea{font:inherit;padding:7px 9px;border:1px solid #999;border-radius:6px}
label{display:block;margin:6px 0}.card{background:#fff;border-radius:10px;padding:14px;margin:10px 0}.muted{color:#666}.error{color:#b00020;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.badge{font-size:12px;padding:2px 7px;border-radius:999px;background:#eee}.backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:50}
.dialog{background:#fff;border-radius:14px;padding:22px;max-width:460px;width:92%}.field{margin:10px 0}.field input,.field select{width:100%}
.layout{display:grid;grid-template-columns:220px 1fr;gap:16px}.price{font-weight:700;font-size:17px}.swatch[aria-pressed=true]{outline:3px solid #e77600}
fieldset{border:1px solid #ddd;border-radius:8px;margin:10px 0}legend{font-weight:600}`

const themes = {
  store: `header{background:#131921;color:#fff;padding:10px 16px}header a{color:#fff;text-decoration:none}.brand{font-weight:800;font-size:22px}
nav.sub{background:#232f3e;padding:6px 16px}nav.sub a{color:#fff;margin-right:14px;text-decoration:none;font-size:14px}
.primary{background:#ffd814;border-color:#fcd200}.buy{background:#ffa41c;border-color:#ff8f00}header input[type=search]{width:min(560px,60vw)}
.cookie{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:3px solid #232f3e;padding:18px 24px;min-height:30vh;z-index:40;box-shadow:0 -8px 24px rgba(0,0,0,.2)}`,
  eats: `header{background:#000;color:#fff;padding:12px 16px}header a{color:#fff;text-decoration:none}.brand{font-weight:800;font-size:22px;letter-spacing:-.5px}
.primary{background:#06c167;border-color:#06c167;color:#fff}.closed{opacity:.6}.chip{border-radius:999px;background:#eee;padding:6px 12px;text-decoration:none;color:#111}
.menu-item{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #eee}`,
}

export function page(options: { app: "store" | "eats"; title: string; header: string; body: string; overlay?: string; script?: string }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(options.title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${base}${themes[options.app]}</style></head>
<body>${options.header}<main>${options.body}</main>${options.overlay ?? ""}
<script>${lazyScript}${options.script ?? ""}</script></body></html>`
}

// Sections marked data-lazy load their HTML only once scrolled near, like infinite menus and review lists.
const lazyScript = `(() => {
  const io = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); setTimeout(() => fetch(e.target.dataset.lazy).then((r) => r.text()).then((h) => { e.target.outerHTML = h }), 350) } }, { rootMargin: "120px" })
  document.querySelectorAll("[data-lazy]").forEach((e) => io.observe(e))
  document.querySelectorAll("[data-autosubmit]").forEach((e) => e.addEventListener("change", () => e.form && e.form.requestSubmit()))
})();`

export function dialog(label: string, body: string) {
  return `<div class="backdrop"><div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(label)}">${body}</div></div>`
}

export function field(name: string, label: string, value: string | undefined, error?: string, extra = "") {
  return `<div class="field"><label for="f-${name}">${esc(label)}</label><input type="text" id="f-${name}" name="${name}" value="${esc(value ?? "")}"${extra}${error ? ` aria-invalid="true" aria-describedby="e-${name}"` : ""}>${error ? `<div class="error" id="e-${name}">${esc(error)}</div>` : ""}</div>`
}

/** Fake payment validation: only the well-known test card passes, and nothing is ever charged. */
export function validateCard(form: URLSearchParams, now = new Date(2026, 9, 24)) {
  const errors: Record<string, string> = {}
  const number = (form.get("card") ?? "").replace(/[\s-]/g, "")
  const exp = (form.get("exp") ?? "").trim()
  const cvc = (form.get("cvc") ?? "").trim()
  const name = (form.get("cardname") ?? "").trim()
  if (form.has("cardname") && !name) errors.cardname = "Enter the name on the card."
  if (!/^\d{12,19}$/.test(number)) errors.card = "Enter a valid card number."
  else if (number !== "4242424242424242") errors.card = "Your card was declined. This is a test store: use 4242 4242 4242 4242."
  const match = /^(\d{2})\s*\/\s*(\d{2})$/.exec(exp)
  if (!match) errors.exp = "Enter the expiry as MM/YY."
  else {
    const month = Number(match[1])
    const year = 2000 + Number(match[2])
    if (month < 1 || month > 12 || year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) errors.exp = "This card has expired."
  }
  if (!/^\d{3}$/.test(cvc)) errors.cvc = "Enter the 3-digit security code."
  return { errors, last4: number.slice(-4) }
}
