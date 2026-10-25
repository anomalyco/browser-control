// Per-run app state. Every agent run gets its own id (a cookie), so runs never see each other's carts.

type GauntletEvent = { readonly at: number; readonly name: string; readonly detail?: Readonly<Record<string, unknown>> }

export type Address = { name: string; street: string; city: string; state: string; zip: string }

export type StoreLine = { productId: string; color?: string; size?: string; qty: number; protection: boolean }

type StoreOrder = {
  id: string
  lines: StoreLine[]
  address: Address
  shipping: string
  promo?: string
  totalCents: number
  cardLast4: string
}

export type EatsLine = { restaurantId: string; itemId: string; qty: number; options: Record<string, string[]>; note?: string }

export type EatsOrder = {
  id: string
  restaurantId: string
  lines: EatsLine[]
  mode: "delivery" | "pickup"
  address?: string
  tipPercent: number
  membership: boolean
  totalCents: number
  cardLast4: string
}

export type RunState = {
  readonly id: string
  readonly createdAt: number
  readonly events: GauntletEvent[]
  store: {
    cookieChoice?: "accepted" | "rejected"
    cart: StoreLine[]
    address?: Address
    shipping?: string
    promo?: string
    orders: StoreOrder[]
  }
  eats: {
    address?: string
    promoDismissed: boolean
    cart: EatsLine[]
    upsellSeen: boolean
    orders: EatsOrder[]
  }
}

export function newRunState(id: string): RunState {
  return {
    id,
    createdAt: Date.now(),
    events: [],
    store: { cart: [], orders: [] },
    eats: { promoDismissed: false, cart: [], upsellSeen: false, orders: [] },
  }
}

export function record(state: RunState, name: string, detail?: Record<string, unknown>) {
  state.events.push(detail ? { at: Date.now(), name, detail } : { at: Date.now(), name })
}
