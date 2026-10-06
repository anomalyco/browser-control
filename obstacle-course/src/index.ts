import { DurableObject } from "cloudflare:workers"
import {
  DEFAULT_HUMAN_MODEL_PROFILE,
  analyzeReach,
  fitHumanModel,
  type HumanModelProfile,
  type ObstacleRunPayload,
} from "../../src/human-model.ts"

interface Env {
  ASSETS: Fetcher
  OBSTACLE_HUB: DurableObjectNamespace<ObstacleHub>
}

type RunSummaryRow = {
  id: string
  handle: string
  device: string
  sample_rate_hz: number
  course_time_ms: number
  reach_count: number
  scroll_count: number
  key_count: number
  throughput_bps: number
  peak_velocity_u: number
  bow_ratio: number
  overshoot_rate: number
  hold_median_ms: number
  iki_median_ms: number
  created_at: number
}

type RosterMember = {
  handle: string
  runs: number
  reaches: number
  scrolls: number
  keys: number
  device: string
  bestTimeMs: number
  throughputBps: number
  peakVelocityU: number
  bowRatio: number
  overshootRate: number
  holdMedianMs: number
  ikiMedianMs: number
  lastActiveAt: number
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders,
    },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders })
    }
    const url = new URL(request.url)
    if (url.pathname.startsWith("/api/")) {
      const hub = env.OBSTACLE_HUB.getByName("anomaly-team-hub-v1")
      return hub.fetch(request)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

export class ObstacleHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          handle TEXT NOT NULL,
          device TEXT NOT NULL,
          sample_rate_hz INTEGER NOT NULL,
          course_time_ms INTEGER NOT NULL,
          reach_count INTEGER NOT NULL,
          scroll_count INTEGER NOT NULL,
          key_count INTEGER NOT NULL,
          throughput_bps REAL NOT NULL,
          peak_velocity_u REAL NOT NULL,
          bow_ratio REAL NOT NULL,
          overshoot_rate REAL NOT NULL,
          hold_median_ms REAL NOT NULL,
          iki_median_ms REAL NOT NULL,
          created_at INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_runs_handle ON runs(handle);
      `)
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/api/live") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 })
      }
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      this.ctx.acceptWebSocket(server)
      const state = this.buildState({
        handle: url.searchParams.get("handle") ?? undefined,
        device: url.searchParams.get("device") ?? undefined,
      })
      server.send(JSON.stringify({ type: "state", state }))
      this.broadcastViewers()
      return new Response(null, { status: 101, webSocket: client })
    }

    if (url.pathname === "/api/state" && request.method === "GET") {
      const handle = url.searchParams.get("handle") ?? undefined
      const device = url.searchParams.get("device") ?? undefined
      return jsonResponse(this.buildState({ handle, device }))
    }

    if (url.pathname === "/api/model" && request.method === "GET") {
      const handle = url.searchParams.get("handle") ?? undefined
      const device = url.searchParams.get("device") ?? undefined
      const state = this.buildState({ handle, device })
      const origin = url.origin
      const query = url.search
      return jsonResponse({
        profile: state.model,
        baseline: DEFAULT_HUMAN_MODEL_PROFILE,
        cliCommand: `mkdir -p ~/.browser-control && curl -fsSL "${origin}/api/model${query}" | jq .profile > ~/.browser-control/human-model.json`,
      })
    }

    if (url.pathname === "/api/export" && request.method === "GET") {
      const rows = this.ctx.storage.sql
        .exec<{ payload_json: string }>("SELECT payload_json FROM runs ORDER BY created_at DESC LIMIT 250")
        .toArray()
      const runs = rows.map((r) => JSON.parse(r.payload_json) as ObstacleRunPayload)
      return jsonResponse({
        exportedAt: Date.now(),
        count: runs.length,
        model: fitHumanModel(runs, `team-export (${runs.length} runs)`),
        runs,
      })
    }

    if (url.pathname.startsWith("/api/runs/") && request.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/runs/".length))
      const rows = this.ctx.storage.sql
        .exec<{ payload_json: string }>("SELECT payload_json FROM runs WHERE id = ? LIMIT 1", id)
        .toArray()
      if (rows.length === 0) {
        return jsonResponse({ error: "Run not found" }, 404)
      }
      const run = JSON.parse(rows[0]!.payload_json) as ObstacleRunPayload
      const model = fitHumanModel([run], `${run.handle} (${run.id ?? id})`)
      const reachAnalyses = run.reaches
        .map((r) => analyzeReach(r))
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
      return jsonResponse({ run, model, reachAnalyses })
    }

    if (url.pathname.startsWith("/api/runs/") && request.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice("/api/runs/".length))
      this.ctx.storage.sql.exec("DELETE FROM runs WHERE id = ?", id)
      const state = this.buildState({})
      this.broadcastState(state)
      return jsonResponse({ ok: true, id, state })
    }

    if (url.pathname === "/api/runs" && request.method === "POST") {
      try {
        const body = (await request.json()) as Partial<ObstacleRunPayload>
        const handle = sanitizeHandle(body.handle)
        const device =
          body.device === "mouse" || body.device === "trackpad" ? body.device : "unknown"
        const reaches = Array.isArray(body.reaches) ? body.reaches.slice(0, 60) : []
        const scrolls = Array.isArray(body.scrolls) ? body.scrolls.slice(0, 30) : []
        const keys = Array.isArray(body.keys) ? body.keys.slice(0, 160) : []
        if (reaches.length < 2) {
          return jsonResponse({ error: "Run requires at least 2 recorded reaches" }, 400)
        }
        const id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
        const createdAt = Date.now()
        const sampleRateHz = clampInt(Number(body.sampleRateHz ?? 60), 20, 1000)
        const courseTimeMs = clampInt(Number(body.courseTimeMs ?? 30_000), 1_000, 600_000)
        const viewport = {
          width: clampInt(Number(body.viewport?.width ?? 1280), 320, 7680),
          height: clampInt(Number(body.viewport?.height ?? 800), 240, 4320),
          dpr: Math.min(4, Math.max(1, Number(body.viewport?.dpr ?? 1))),
        }

        const payload: ObstacleRunPayload = {
          id,
          handle,
          device,
          sampleRateHz,
          viewport,
          createdAt,
          courseTimeMs,
          reaches,
          scrolls,
          keys,
        }

        const personalRunModel = fitHumanModel([payload], `${handle} · ${id}`)
        const ikiList = keys.map((k) => k.ikiMs).filter((v) => v > 12 && v < 450)
        const ikiMedianMs = ikiList.length > 0 ? median(ikiList) : personalRunModel.keyboard.gapMaxMs * 2

        this.ctx.storage.sql.exec(
          `INSERT INTO runs (
            id, handle, device, sample_rate_hz, course_time_ms,
            reach_count, scroll_count, key_count,
            throughput_bps, peak_velocity_u, bow_ratio, overshoot_rate,
            hold_median_ms, iki_median_ms, created_at, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          handle,
          device,
          sampleRateHz,
          courseTimeMs,
          reaches.length,
          scrolls.length,
          keys.length,
          personalRunModel.reach.throughputBps,
          personalRunModel.reach.peakVelocityU,
          Math.round(((personalRunModel.reach.bowMinRatio + personalRunModel.reach.bowMaxRatio) / 2) * 10000) / 10000,
          personalRunModel.submovements.overshootRate,
          Math.round((personalRunModel.click.holdMinMs + personalRunModel.click.holdMaxMs) / 2),
          Math.round(ikiMedianMs),
          createdAt,
          JSON.stringify(payload),
        )

        const state = this.buildState({})
        this.broadcastState(state)
        return jsonResponse({
          ok: true,
          id,
          personalModel: personalRunModel,
          state,
        })
      } catch (error) {
        return jsonResponse(
          { error: error instanceof Error ? error.message : "Invalid run payload" },
          400,
        )
      }
    }

    return jsonResponse({ error: "Not found" }, 404)
  }

  async webSocketClose(): Promise<void> {
    this.broadcastViewers()
  }

  async webSocketError(): Promise<void> {
    this.broadcastViewers()
  }

  private activeViewerCount(): number {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).length
  }

  private broadcastViewers(): void {
    const message = JSON.stringify({ type: "viewers", activeViewers: this.activeViewerCount() })
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message)
      } catch {
        ws.close(1011, "Broadcast failed")
      }
    }
  }

  private broadcastState(state: ReturnType<ObstacleHub["buildState"]>): void {
    const message = JSON.stringify({ type: "state", state })
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message)
      } catch {
        ws.close(1011, "Broadcast failed")
      }
    }
  }

  private buildState(filter: { handle?: string | undefined; device?: string | undefined }) {
    const summaryRows = this.ctx.storage.sql
      .exec<RunSummaryRow>(
        `SELECT
          id, handle, device, sample_rate_hz, course_time_ms,
          reach_count, scroll_count, key_count,
          throughput_bps, peak_velocity_u, bow_ratio, overshoot_rate,
          hold_median_ms, iki_median_ms, created_at
         FROM runs
         ORDER BY created_at DESC
         LIMIT 200`,
      )
      .toArray()

    const byHandle = new Map<string, RunSummaryRow[]>()
    for (const row of summaryRows) {
      const list = byHandle.get(row.handle) ?? []
      list.push(row)
      byHandle.set(row.handle, list)
    }

    const roster: RosterMember[] = Array.from(byHandle.entries())
      .map(([handle, rows]) => {
        const reaches = rows.reduce((s, r) => s + r.reach_count, 0)
        const scrolls = rows.reduce((s, r) => s + r.scroll_count, 0)
        const keys = rows.reduce((s, r) => s + r.key_count, 0)
        const bestTimeMs = Math.min(...rows.map((r) => r.course_time_ms))
        return {
          handle,
          runs: rows.length,
          reaches,
          scrolls,
          keys,
          device: rows[0]?.device ?? "unknown",
          bestTimeMs,
          throughputBps: round(median(rows.map((r) => r.throughput_bps)), 2),
          peakVelocityU: round(median(rows.map((r) => r.peak_velocity_u)), 3),
          bowRatio: round(median(rows.map((r) => r.bow_ratio)), 4),
          overshootRate: round(median(rows.map((r) => r.overshoot_rate)), 3),
          holdMedianMs: Math.round(median(rows.map((r) => r.hold_median_ms))),
          ikiMedianMs: Math.round(median(rows.map((r) => r.iki_median_ms))),
          lastActiveAt: rows[0]?.created_at ?? 0,
        }
      })
      .sort((a, b) => b.reaches - a.reaches || a.bestTimeMs - b.bestTimeMs)

    const clauses: string[] = []
    const bindings: (string | number)[] = []
    if (filter.handle && filter.handle !== "all") {
      clauses.push("handle = ?")
      bindings.push(sanitizeHandle(filter.handle))
    }
    if (filter.device && (filter.device === "mouse" || filter.device === "trackpad")) {
      clauses.push("device = ?")
      bindings.push(filter.device)
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const payloadRows = this.ctx.storage.sql
      .exec<{ payload_json: string }>(
        `SELECT payload_json FROM runs ${whereClause} ORDER BY created_at DESC LIMIT 80`,
        ...bindings,
      )
      .toArray()

    const matchingRuns = payloadRows.map((r) => JSON.parse(r.payload_json) as ObstacleRunPayload)
    const distinctHandles = new Set(matchingRuns.map((r) => r.handle)).size
    const labelParts = [
      filter.handle && filter.handle !== "all" ? `@${sanitizeHandle(filter.handle)}` : "team-aggregate",
      filter.device && filter.device !== "all" ? filter.device : undefined,
      `${matchingRuns.length} runs`,
      distinctHandles > 0 ? `${distinctHandles} ${distinctHandles === 1 ? "person" : "people"}` : undefined,
    ].filter(Boolean)

    const model: HumanModelProfile = fitHumanModel(matchingRuns, labelParts.join(" · "))

    return {
      activeViewers: this.activeViewerCount(),
      filter: {
        handle: filter.handle ?? "all",
        device: filter.device ?? "all",
      },
      totals: {
        runs: summaryRows.length,
        people: roster.length,
        reaches: summaryRows.reduce((s, r) => s + r.reach_count, 0),
        scrolls: summaryRows.reduce((s, r) => s + r.scroll_count, 0),
        keys: summaryRows.reduce((s, r) => s + r.key_count, 0),
      },
      model,
      baseline: DEFAULT_HUMAN_MODEL_PROFILE,
      roster,
      recentRuns: summaryRows.slice(0, 24).map((r) => ({
        id: r.id,
        handle: r.handle,
        device: r.device,
        sampleRateHz: r.sample_rate_hz,
        courseTimeMs: r.course_time_ms,
        reaches: r.reach_count,
        scrolls: r.scroll_count,
        keys: r.key_count,
        throughputBps: r.throughput_bps,
        peakVelocityU: r.peak_velocity_u,
        bowRatio: r.bow_ratio,
        overshootRate: r.overshoot_rate,
        holdMedianMs: r.hold_median_ms,
        ikiMedianMs: r.iki_median_ms,
        createdAt: r.created_at,
      })),
    }
  }
}

function sanitizeHandle(raw: unknown): string {
  if (typeof raw !== "string") return "anon"
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 24)
  return cleaned || "anon"
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function round(value: number, digits = 3): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}
