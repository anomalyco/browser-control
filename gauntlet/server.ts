import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Two loopback origins serving gauntlet/fixtures. The secondary origin exists so
 * the payment iframe is a real cross-origin OOPIF; everything else lives on the
 * primary origin. Ports are fixed by default so fixture URLs are stable across
 * runs and readable in relay status output.
 */
export type GauntletServers = {
  readonly primaryOrigin: string
  readonly secondaryOrigin: string
  readonly close: () => Promise<void>
}

export type GauntletServerOptions = {
  readonly primaryPort?: number
  readonly secondaryPort?: number
  readonly host?: string
  readonly stallKeepaliveMs?: number
}

const fixturesDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const secondaryOriginPlaceholder = "__SECONDARY_ORIGIN__"

export const defaultPrimaryPort = 19801
export const defaultSecondaryPort = 19802

export async function startGauntletServers(options: GauntletServerOptions = {}): Promise<GauntletServers> {
  const host = options.host ?? "127.0.0.1"
  const primaryPort = options.primaryPort ?? defaultPrimaryPort
  const secondaryPort = options.secondaryPort ?? defaultSecondaryPort
  const secondaryOrigin = `http://${host}:${secondaryPort}`
  const stallKeepaliveMs = options.stallKeepaliveMs ?? 5_000
  const openStalls = new Set<http.ServerResponse>()

  const primary = http.createServer((request, response) => {
    void handleRequest(request, response, { secondaryOrigin, stallKeepaliveMs, openStalls })
  })
  const secondary = http.createServer((request, response) => {
    void handleRequest(request, response, { secondaryOrigin, stallKeepaliveMs, openStalls })
  })

  await listen(primary, primaryPort, host)
  try {
    await listen(secondary, secondaryPort, host)
  } catch (error) {
    await closeServer(primary)
    throw error
  }

  return {
    primaryOrigin: `http://${host}:${primaryPort}`,
    secondaryOrigin,
    close: async () => {
      for (const response of openStalls) response.destroy()
      openStalls.clear()
      await Promise.all([closeServer(primary), closeServer(secondary)])
    },
  }
}

type RequestContext = {
  readonly secondaryOrigin: string
  readonly stallKeepaliveMs: number
  readonly openStalls: Set<http.ServerResponse>
}

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse, context: RequestContext): Promise<void> {
  const url = new URL(request.url ?? "/", "http://gauntlet.invalid")
  try {
    if (url.pathname === "/stalled-main-world.html") {
      await serveStalledMainWorld(url, response, context)
      return
    }
    if (url.pathname === "/auth/app") {
      if (!hasCookie(request, "bc_auth")) {
        response.writeHead(302, { location: `/auth/sign-in?next=${encodeURIComponent("/auth/app")}`, "cache-control": "no-store" })
        response.end()
        return
      }
      await serveFixture("auth-app.html", response, context)
      return
    }
    if (url.pathname === "/auth/sign-in") {
      await serveFixture("auth-redirect-handoff.html", response, context)
      return
    }
    if (url.pathname === "/auth/reset") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "set-cookie": ["bc_auth=; path=/; max-age=0", "bc_csrf=; path=/; max-age=0"],
        "cache-control": "no-store",
      })
      response.end("auth cookies cleared")
      return
    }
    const fileName = url.pathname.replace(/^\/+/, "")
    if (/^[a-z0-9-]+\.html$/.test(fileName)) {
      await serveFixture(fileName, response, context)
      return
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    response.end("Not found")
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
    response.end(error instanceof Error ? error.message : "fixture server error")
  }
}

async function serveFixture(fileName: string, response: http.ServerResponse, context: RequestContext): Promise<void> {
  const body = (await readFixture(fileName)).replaceAll(secondaryOriginPlaceholder, context.secondaryOrigin)
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
  response.end(body)
}

/**
 * Writes the entire document immediately so it paints, then keeps the response
 * open with periodic HTML comments so document.readyState never leaves
 * "loading". `?hostile=0` serves the same document as a normal, completing page.
 */
async function serveStalledMainWorld(url: URL, response: http.ServerResponse, context: RequestContext): Promise<void> {
  const body = await readFixture("stalled-main-world.html")
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" })
  if (url.searchParams.get("hostile") !== "1") {
    response.end(body)
    return
  }
  response.write(body.replace(/<\/body>\s*<\/html>\s*$/, ""))
  response.flushHeaders()
  context.openStalls.add(response)
  const keepalive = setInterval(() => {
    if (response.destroyed || response.writableEnded) {
      clearInterval(keepalive)
      context.openStalls.delete(response)
      return
    }
    response.write(`<!-- keepalive ${Date.now()} -->\n`)
  }, context.stallKeepaliveMs)
  response.once("close", () => {
    clearInterval(keepalive)
    context.openStalls.delete(response)
  })
}

const fixtureCache = new Map<string, Promise<string>>()

function readFixture(fileName: string): Promise<string> {
  const cached = fixtureCache.get(fileName)
  if (cached) return cached
  const pending = fs.readFile(path.join(fixturesDirectory, fileName), "utf8").catch((error: unknown) => {
    fixtureCache.delete(fileName)
    throw error instanceof Error ? error : new Error(`read fixture ${fileName}`)
  })
  fixtureCache.set(fileName, pending)
  return pending
}

function hasCookie(request: http.IncomingMessage, name: string): boolean {
  const header = request.headers.cookie ?? ""
  return header.split(";").some((part) => part.trim().startsWith(`${name}=`) && part.trim() !== `${name}=`)
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening)
      reject(error.code === "EADDRINUSE"
        ? new Error(`Gauntlet fixture port ${port} is already in use. Set GAUNTLET_PRIMARY_PORT / GAUNTLET_SECONDARY_PORT to free ports.`, { cause: error })
        : error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}
