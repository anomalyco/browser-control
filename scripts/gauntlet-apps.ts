#!/usr/bin/env tsx
// App gauntlet: run browser agents through the fake Junglemart and Grubber apps, grade each run by
// the server's final state, and write JSONL plus a summary. Headless Chromium, throwaway contexts,
// and every request outside the loopback app origin is aborted.
//
//   pnpm gauntlet:apps                                   # scripted reference policy
//   bun scripts/gauntlet-apps.ts --policy ./my-agent.ts --arms a,b --tasks store-checkout --reps 3
//   pnpm gauntlet:apps --report a.jsonl,b.jsonl          # one summary over several runs
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { pathToFileURL } from "node:url"
import { chromium } from "playwright-core"
import type { GauntletPolicy, PolicyStep } from "../gauntlet/apps/policy.ts"
import { reference } from "../gauntlet/apps/reference.ts"
import { startAppServer, type AppServer } from "../gauntlet/apps/server.ts"
import type { RunState } from "../gauntlet/apps/state.ts"
import { progressOf, tasks, type GauntletTask } from "../gauntlet/apps/tasks.ts"

const { values: args } = parseArgs({
  options: {
    policy: { type: "string" },
    arms: { type: "string" },
    tasks: { type: "string", default: "all" },
    reps: { type: "string", default: "1" },
    out: { type: "string" },
    "run-timeout": { type: "string", default: "300" },
    list: { type: "boolean", default: false },
    /** Comma-separated JSONL files to summarize together, without running anything. */
    report: { type: "string" },
    /** Keep the rows already in --out and run only the missing rep/task/arm combinations. */
    resume: { type: "boolean", default: false },
  },
})

if (args.list) {
  for (const t of tasks) console.log(`${t.id.padEnd(24)} ${t.app.padEnd(5)} ${t.difficulty.padEnd(6)} ${t.obstacles.join(", ")}`)
  process.exit(0)
}

class StepLimit extends Error {}

async function loadPolicies(): Promise<GauntletPolicy[]> {
  if (!args.policy) return [reference]
  const mod = (await import(pathToFileURL(path.resolve(args.policy)).href)) as Record<string, unknown>
  const exported = mod.default ?? mod.policies ?? mod.policy
  const list = (Array.isArray(exported) ? exported : exported && typeof exported === "object" && "run" in exported ? [exported] : Object.values(exported ?? {})) as GauntletPolicy[]
  if (!list.length || list.some((p) => typeof p?.run !== "function")) throw new Error(`${args.policy} must export a GauntletPolicy, an array of them, or a record of them`)
  return list
}

async function readState(server: AppServer, id: string) {
  const res = await fetch(`${server.origin}/__gauntlet/runs/${id}`, { headers: { "x-gauntlet-key": server.key } })
  if (!res.ok) throw new Error(`state ${id}: HTTP ${res.status}`)
  return (await res.json()) as RunState
}

async function runOne(server: AppServer, browser: Awaited<ReturnType<typeof chromium.launch>>, task: GauntletTask, policy: GauntletPolicy) {
  const created = (await (await fetch(`${server.origin}/__gauntlet/runs`, { method: "POST", headers: { "x-gauntlet-key": server.key }, body: JSON.stringify({ task: task.id }) })).json()) as { id: string; startPath: string }
  const context = await browser.newContext({ viewport: { width: 1120, height: 780 }, locale: "en-US" })
  const blocked: string[] = []
  await context.route("**/*", (route) => {
    const url = route.request().url()
    if (url.startsWith(`${server.origin}/`)) return route.continue()
    blocked.push(url.slice(0, 120))
    return route.abort("blockedbyclient")
  })
  const page = await context.newPage()
  const steps: (PolicyStep & { n: number; at: number; milestones: number })[] = []
  let lastAdvance = 0
  const t0 = performance.now()
  let status = "error"
  let detail: string | undefined
  let costUsd = 0
  let modelMs = 0
  try {
    await page.goto(`${server.origin}${created.startPath}?to=${encodeURIComponent(task.start)}`, { waitUntil: "domcontentloaded" })
    const result = await Promise.race([
      policy.run({
        task,
        page,
        maxSteps: task.maxSteps,
        step: async (s) => {
          if (steps.length >= task.maxSteps) throw new StepLimit(`step limit ${task.maxSteps}`)
          const reached = progressOf(task, await readState(server, created.id)).reached.length
          if (reached > (steps.at(-1)?.milestones ?? 0)) lastAdvance = steps.length + 1
          steps.push({ ...s, n: steps.length + 1, at: Math.round(performance.now() - t0), milestones: reached })
        },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("run timeout")), Number(args["run-timeout"]) * 1000).unref()),
    ])
    status = result.status
    detail = result.detail
    costUsd = result.costUsd ?? steps.reduce((n, s) => n + (s.costUsd ?? 0), 0)
    modelMs = result.modelMs ?? 0
  } catch (error) {
    status = error instanceof StepLimit ? "max_steps" : "error"
    detail = error instanceof Error ? error.message.split("\n")[0] : String(error)
    costUsd = steps.reduce((n, s) => n + (s.costUsd ?? 0), 0)
  }
  const wallMs = Math.round(performance.now() - t0)
  const state = await readState(server, created.id)
  await context.close()
  const check = task.grade(state)
  const progress = progressOf(task, state)
  return {
    task: task.id,
    app: task.app,
    difficulty: task.difficulty,
    arm: policy.name,
    success: check.ok,
    status,
    steps: steps.length,
    wallMs,
    modelMs,
    costUsd,
    milestones: `${progress.reached.length}/${task.milestones.length}`,
    failedAt: check.ok ? null : progress.failedAt,
    failedAfterStep: check.ok ? null : lastAdvance,
    blockedRequests: blocked.length,
    detail: check.ok ? undefined : [detail, check.detail].filter(Boolean).join(" | ").slice(0, 400),
    trace: steps,
    events: state.events.map((e) => e.name),
  }
}

type Row = Awaited<ReturnType<typeof runOne>> & { rep: number }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0
}

function summarize(rows: Row[], arms: string[]) {
  const by = (arm: string, task?: string) => rows.filter((r) => r.arm === arm && (!task || r.task === task))
  const lines = ["| Arm | Success | Median wall | Mean steps | Cost / task | Cost / success |", "|---|---:|---:|---:|---:|---:|"]
  for (const arm of arms) {
    const rs = by(arm)
    const ok = rs.filter((r) => r.success).length
    const cost = rs.reduce((n, r) => n + r.costUsd, 0)
    lines.push(`| ${arm} | ${ok}/${rs.length} | ${(median(rs.map((r) => r.wallMs)) / 1000).toFixed(1)} s | ${(rs.reduce((n, r) => n + r.steps, 0) / Math.max(1, rs.length)).toFixed(1)} | $${(cost / Math.max(1, rs.length)).toFixed(5)} | ${ok ? `$${(cost / ok).toFixed(5)}` : "—"} |`)
  }
  lines.push("", `| Task | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---:").join("|")}|`)
  for (const task of [...new Set(rows.map((r) => r.task))]) {
    lines.push(`| ${task} | ${arms.map((arm) => {
      const rs = by(arm, task)
      const fails = rs.filter((r) => !r.success).map((r) => r.failedAt)
      return `${rs.filter((r) => r.success).length}/${rs.length}${fails.length ? ` (${[...new Set(fails)].join("; ")})` : ""}`
    }).join(" | ")} |`)
  }
  return lines.join("\n")
}

if (args.report) {
  const rows = args.report.split(",").flatMap((file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row))
  const summary = summarize(rows, args.arms ? args.arms.split(",") : [...new Set(rows.map((r) => r.arm))])
  if (args.out) fs.writeFileSync(args.out, summary + "\n")
  console.log(summary)
  process.exit(0)
}

const policies = await loadPolicies()
const arms = args.arms ? args.arms.split(",") : policies.map((p) => p.name)
const chosen = arms.map((a) => policies.find((p) => p.name === a) ?? (() => { throw new Error(`unknown arm ${a}; have ${policies.map((p) => p.name).join(", ")}`) })())
const selected = args.tasks === "all" ? tasks : tasks.filter((t) => args.tasks!.split(",").some((x) => x === t.id || x === t.app || x === t.difficulty))
const out = args.out ?? path.join("artifacts", "gauntlet-apps", `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })

const rows: Row[] = args.resume && fs.existsSync(out) ? fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row) : []
const done = new Set(rows.map((r) => `${r.rep}|${r.task}|${r.arm}`))
const server = await startAppServer()
const browser = await chromium.launch({ headless: true, args: ["--disable-gpu", "--mute-audio", "--no-first-run"] })
try {
  for (let rep = 1; rep <= Number(args.reps); rep++)
    for (const task of selected)
      for (const policy of rep % 2 ? chosen : [...chosen].reverse()) {
        if (done.has(`${rep}|${task.id}|${policy.name}`)) continue
        const row = { rep, ...(await runOne(server, browser, task, policy)) }
        rows.push(row)
        fs.appendFileSync(out, JSON.stringify({ ...row, at: new Date().toISOString() }) + "\n")
        console.log(`${rep} ${task.id.padEnd(24)} ${policy.name.padEnd(10)} ${row.success ? "PASS" : "fail"} ${row.status.padEnd(9)} steps=${row.steps} wall=${(row.wallMs / 1000).toFixed(1)}s $${row.costUsd.toFixed(5)}${row.success ? "" : `  stalled at "${row.failedAt}" after step ${row.failedAfterStep}: ${row.detail?.slice(0, 120) ?? ""}`}`)
      }
} finally {
  await browser.close()
  await server.close()
}
const summary = summarize(rows, arms)
fs.writeFileSync(out.replace(/\.jsonl$/, "") + ".summary.md", summary + "\n")
console.log(`\n${summary}\n\nWrote ${out}`)
if (!args.policy && rows.some((r) => !r.success)) process.exit(1)
