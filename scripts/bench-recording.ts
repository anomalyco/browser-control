import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

const measuredRuns = positiveInteger(process.env.BENCH_RUNS, 7)
const warmupRuns = positiveInteger(process.env.BENCH_WARMUPS, 1)
const durationMs = positiveInteger(process.env.BENCH_DURATION_MS, 6_000)
const results: RecordingMetrics[] = []

for (let index = 0; index < warmupRuns + measuredRuns; index += 1) {
  const session = `recording-bench-${process.pid}-${index}`
  const outputPath = path.resolve(`tmp/${session}.mp4`)
  runBrowserControl(["session", "new", session])
  try {
    runBrowserControl(["execute", "--session", session, setupCode()])
    runBrowserControl([
      "recording",
      "start",
      outputPath,
      "--session",
      session,
      "--mode",
      "cdp",
      "--frame-rate",
      "25",
      "--max-duration-ms",
      String(durationMs + 10_000),
    ])
    runBrowserControl(["execute", "--session", session, animateCode(durationMs)])
    runBrowserControl(["recording", "stop", "--session", session])
    const metrics = JSON.parse(await fs.readFile(`${outputPath}.json`, "utf8")) as RecordingMetrics
    const encodedSourceFps = metrics.encodedSourceFrameCount / (metrics.durationMs / 1_000)
    const dropRatio = metrics.droppedFrameCount / Math.max(1, metrics.sourceFrameCount)
    console.log(`${index < warmupRuns ? "warmup" : "run"} ${index + 1}: encoded_source_fps=${encodedSourceFps.toFixed(2)} drop_ratio=${dropRatio.toFixed(4)}`)
    if (index >= warmupRuns) results.push(metrics)
  } finally {
    runBrowserControl(["recording", "cancel", "--session", session], true)
    runBrowserControl(["session", "delete", session], true)
    if (process.env.BENCH_KEEP_ARTIFACTS !== "1") {
      await fs.rm(outputPath, { force: true })
      await fs.rm(`${outputPath}.json`, { force: true })
    }
  }
}

const encodedSourceFps = results.map((metrics) => metrics.encodedSourceFrameCount / (metrics.durationMs / 1_000))
const dropRatios = results.map((metrics) => metrics.droppedFrameCount / Math.max(1, metrics.sourceFrameCount))
console.log(`METRIC recording_encoded_source_fps=${median(encodedSourceFps).toFixed(3)}`)
console.log(`METRIC recording_drop_ratio=${median(dropRatios).toFixed(5)}`)
console.log(`METRIC recording_encoded_source_fps_min=${Math.min(...encodedSourceFps).toFixed(3)}`)
console.log(`METRIC recording_encoded_source_fps_max=${Math.max(...encodedSourceFps).toFixed(3)}`)

type RecordingMetrics = {
  readonly durationMs: number
  readonly sourceFrameCount: number
  readonly encodedSourceFrameCount: number
  readonly droppedFrameCount: number
}

function runBrowserControl(args: string[], ignoreFailure = false): void {
  const result = spawnSync("browser-control", args, { encoding: "utf8" })
  if (!ignoreFailure && result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `browser-control ${args.join(" ")} failed`)
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, got ${value}`)
  return parsed
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle]
  if (upper === undefined) throw new Error("No benchmark results")
  if (sorted.length % 2 === 1) return upper
  return ((sorted[middle - 1] ?? upper) + upper) / 2
}

function setupCode(): string {
  return String.raw`
await page.setContent(
  '<style>' +
  'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#080b16;color:white;font-family:system-ui}' +
  '.grid{position:absolute;inset:-20%;background:repeating-linear-gradient(45deg,#172554 0 22px,#1e3a8a 22px 44px);opacity:.7}' +
  '.orb{position:absolute;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle at 30% 30%,#fff,#67e8f9 18%,#2563eb 55%,#172554);box-shadow:0 0 90px #38bdf8}' +
  '.ticker{position:absolute;left:0;right:0;bottom:8%;font-size:72px;font-weight:800;white-space:nowrap;letter-spacing:-.04em}' +
  '.running .grid{animation:grid 2s linear infinite}.running .orb{animation:orbit 2.4s ease-in-out infinite alternate}.running .ticker{animation:ticker 3s linear infinite}' +
  '@keyframes grid{to{transform:translate3d(88px,88px,0)}}' +
  '@keyframes orbit{from{transform:translate3d(8vw,10vh,0) rotate(0)}to{transform:translate3d(78vw,58vh,0) rotate(360deg)}}' +
  '@keyframes ticker{from{transform:translateX(100%)}to{transform:translateX(-130%)}}' +
  '</style><div class="grid"></div><div class="orb"></div><div class="ticker">BROWSER CONTROL · SMOOTH MOTION ·</div>'
)
return await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
`
}

function animateCode(milliseconds: number): string {
  return `await page.evaluate(() => document.documentElement.classList.add("running")); await page.waitForTimeout(${milliseconds}); return true`
}
