// One loopback server for every gauntlet app. Each run is isolated by a `gx_run` cookie. Graders
// read final state from /__gauntlet/runs/<id>, which needs the per-server key the agent never sees.
import { randomBytes } from "node:crypto"
import http from "node:http"
import { eatsRoute } from "./eats.ts"
import { esc, type AppRequest, type AppResponse } from "./html.ts"
import { newRunState, type RunState } from "./state.ts"
import { storeRoute } from "./store.ts"
import { tasks } from "./tasks.ts"

export type AppServer = {
  readonly origin: string
  readonly key: string
  readonly close: () => Promise<void>
}

const COOKIE = "gx_run"
// Pages may load only same-origin resources, so nothing an agent does here reaches the network.
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'"

const index = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gauntlet apps</title></head><body style="font:16px system-ui;margin:40px">
<h1>Gauntlet apps</h1><p>Fake, deterministic recreations for browser-agent evals. Nothing is sold or charged.</p>
<ul><li><a href="/store/">Junglemart</a> (an Amazon-style store)</li><li><a href="/eats/">Grubber</a> (an Uber Eats-style delivery app)</li></ul></body></html>`

export async function startAppServer(options: { port?: number; host?: string } = {}): Promise<AppServer> {
  const host = options.host ?? "127.0.0.1"
  const key = randomBytes(16).toString("hex")
  const runs = new Map<string, RunState>()

  const createRun = (taskId: string | undefined) => {
    const task = taskId ? tasks.find((t) => t.id === taskId) : undefined
    if (taskId && !task) throw new Error(`unknown task ${taskId}`)
    const id = randomBytes(8).toString("hex")
    const state = newRunState(id)
    task?.seed?.(state)
    runs.set(id, state)
    return state
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${host}`)
      const send = (res: AppResponse, cookie?: string) => {
        response.writeHead(res.status, { "cache-control": "no-store", "content-security-policy": CSP, ...(cookie ? { "set-cookie": `${COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax` } : {}), ...res.headers })
        response.end(res.body ?? "")
      }
      const body = request.method === "POST" ? await readBody(request) : ""

      if (url.pathname.startsWith("/__gauntlet/runs")) {
        if (request.headers["x-gauntlet-key"] !== key) return send({ status: 404, body: "Not found" })
        const json = (value: unknown, status = 200) => send({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) })
        if (url.pathname === "/__gauntlet/runs" && request.method === "POST") {
          const taskId = body ? (JSON.parse(body) as { task?: string }).task : undefined
          const state = createRun(taskId)
          return json({ id: state.id, startPath: `/__gauntlet/start/${state.id}` })
        }
        const state = runs.get(url.pathname.split("/")[3] ?? "")
        return state ? json(state) : json({ error: "unknown run" }, 404)
      }
      const start = /^\/__gauntlet\/start\/(\w+)$/.exec(url.pathname)
      if (start) {
        const to = url.searchParams.get("to") ?? "/"
        return runs.has(start[1]!) ? send({ status: 303, headers: { location: to.startsWith("/") && !to.startsWith("//") ? to : "/" } }, start[1]) : send({ status: 404, body: "Unknown run" })
      }

      const cookieId = /(?:^|;\s*)gx_run=(\w+)/.exec(request.headers.cookie ?? "")?.[1]
      let state = cookieId ? runs.get(cookieId) : undefined
      const fresh = !state
      state ??= createRun(undefined)
      const req: AppRequest = { method: request.method ?? "GET", url, form: new URLSearchParams(body), state }
      const res = url.pathname === "/" ? { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: index } : storeRoute(req) ?? eatsRoute(req)
      send(res ?? { status: 404, headers: { "content-type": "text/html; charset=utf-8" }, body: `<h1>Page not found</h1><p>${esc(url.pathname)}</p><a href="/">Home</a>` }, fresh ? state.id : undefined)
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" })
      response.end(`gauntlet app error: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return {
    origin: `http://${host}:${port}`,
    key,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

function readBody(request: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let data = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      data += chunk
      if (data.length > 1_000_000) request.destroy(new Error("body too large"))
    })
    request.on("end", () => resolve(data))
    request.on("error", reject)
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startAppServer({ port: Number(process.env.GAUNTLET_APPS_PORT ?? 19830) })
  console.log(`gauntlet apps: ${server.origin}/  (Junglemart /store/, Grubber /eats/)`)
}
