import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startAppServer, type AppServer } from "../gauntlet/apps/server.ts"
import { newRunState } from "../gauntlet/apps/state.ts"
import { tasks } from "../gauntlet/apps/tasks.ts"

describe("gauntlet apps", () => {
  let server: AppServer
  beforeAll(async () => {
    server = await startAppServer()
  })
  afterAll(() => server.close())

  it("fails every task on its untouched starting state", () => {
    for (const task of tasks) {
      const state = newRunState("t")
      task.seed?.(state)
      expect(task.grade(state).ok, task.id).toBe(false)
    }
  })

  it("hides run state from anyone without the server key", async () => {
    const created = (await (await fetch(`${server.origin}/__gauntlet/runs`, { method: "POST", headers: { "x-gauntlet-key": server.key }, body: JSON.stringify({ task: "store-checkout" }) })).json()) as { id: string }
    expect((await fetch(`${server.origin}/__gauntlet/runs/${created.id}`)).status).toBe(404)
    expect((await fetch(`${server.origin}/__gauntlet/runs/${created.id}`, { headers: { "x-gauntlet-key": server.key } })).status).toBe(200)
  })

  it("records a cart change made through the store's forms", async () => {
    const start = await fetch(`${server.origin}/store/`)
    const cookie = start.headers.get("set-cookie")?.split(";")[0] ?? ""
    const add = await fetch(`${server.origin}/store/cart/add`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "product=skillet-hearth&qty=1" })
    expect(add.status).toBe(200)
    expect(await add.text()).toContain("Please select a Size.")
    const ok = await fetch(`${server.origin}/store/cart/add`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "product=skillet-hearth&size=10-inch&qty=1" })
    expect(ok.status).toBe(303)
    const id = cookie.split("=")[1]
    const state = (await (await fetch(`${server.origin}/__gauntlet/runs/${id}`, { headers: { "x-gauntlet-key": server.key } })).json()) as { store: { cart: unknown[] } }
    expect(state.store.cart).toEqual([{ productId: "skillet-hearth", size: "10-inch", qty: 1, protection: false }])
  })
})
