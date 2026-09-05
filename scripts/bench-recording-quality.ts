import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { once } from "node:events"
import { WebSocket } from "ws"
import { chromium, type CDPSession } from "playwright-core"
import { RecordingRelay } from "../src/recording-relay.ts"
import { getObject } from "../src/relay-helpers.ts"
import type { JsonObject } from "../src/protocol.ts"

// Real Chromium -> production RecordingRelay -> ffmpeg. --session is destructive
// to its one fixture page: use only a new, disposable Browser Control session.
const { values } = parseArgs({ options: {
  browser: { type: "string" }, out: { type: "string" }, runs: { type: "string", default: "7" },
  width: { type: "string", default: "1280" }, height: { type: "string", default: "720" },
  dpr: { type: "string", default: "2" }, headed: { type: "boolean", default: false }, session: { type: "string" },
  "backing-surface": { type: "boolean", default: false },
  verify: { type: "boolean", default: false },
  format: { type: "string", default: "mp4" },
} })
if (!values.out) throw new Error("Pass --out <fresh artifact directory>")
const directory = path.resolve(values.out)
await fs.mkdir(directory)
const width = Number(values.width)
const height = Number(values.height)
const runs = Number(values.runs)
if (![width, height, runs].every((value) => Number.isInteger(value) && value > 0)) throw new Error("Invalid dimensions/runs")
if (values.format !== "mp4" && values.format !== "webm") throw new Error("Format must be mp4 or webm")
const browser = values.session
  ? await chromium.connectOverCDP("http://127.0.0.1:19989", { headers: { "Browser-Control-Session-Id": values.session } })
  : await chromium.launch({ headless: !values.headed, ...(values.browser ? { executablePath: values.browser } : {}) })
const results = []
let recordingRelay: RecordingRelay | undefined
let socket: WebSocket | undefined
try {
  const context = values.session ? browser.contexts()[0]! : await browser.newContext({ viewport: values["backing-surface"] ? { width: 2560, height: 1273 } : { width, height }, deviceScaleFactor: Number(values.dpr) })
  if (values.session && context.pages().length !== 1) throw new Error("Expected exactly one owned benchmark page")
  const page = values.session ? context.pages()[0]! : await context.newPage()
  await page.setViewportSize(values["backing-surface"] ? { width: 2560, height: 1273 } : { width, height })
  await page.setContent(`<!doctype html><style>
    *{box-sizing:border-box}body{margin:0;background:#fff;color:#151515;font:16px Arial,sans-serif}
    main{margin:48px;border:1px solid #ccc;border-radius:8px;padding:24px;height:${height - 260}px}
    h1{font-size:28px;margin:0 0 24px}p{margin:12px 0}.small{font-size:12px}
    button{font:inherit;padding:8px 16px;border:1px solid #ccc;border-radius:6px;background:white}
    .color{color:#185adb}.motion{position:absolute;left:48px;right:48px;bottom:40px;height:100px;background:#000;overflow:hidden}
    .bar{width:8px;height:100%;background:white;animation:move 2s linear infinite alternate}
    @keyframes move{to{transform:translateX(${width - 112}px)}}
    .corner{position:absolute;width:16px;height:16px;background:#eb00eb;right:0;bottom:0}
  </style><main><h1>Workspace settings — recording quality</h1>
    <p>Reply model: Example model (Example custom provider)</p>
    <p>The workspace pays for replies and background response checks.</p>
    <p class="small">Small UI text: 0123456789 Il1 O0 Settings / Usage / API keys</p>
    <p class="color">Colored text and thin borders must remain readable without upscaling.</p>
    <button>Reconnect Slack</button> <button>Disconnect Slack</button>
  </main><div class="motion"><div class="bar"></div></div><div class="corner"></div>`)
  const cdp = await context.newCDPSession(page)
  await cdp.send("Page.enable")
  // One raw target alias receives root events through the extension transport.
  // A second Playwright CDPSession currently receives no screencast events here.
  const pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void }>()
  let requestID = 0
  let sessionID: string | undefined
  const send = (method: string, params: JsonObject): Promise<JsonObject> => {
    if (!socket) return cdp.send(method as Parameters<CDPSession["send"]>[0], params).then((value) => getObject(value) ?? {})
    return new Promise((resolve, reject) => {
      const id = ++requestID
      pending.set(id, { resolve, reject })
      socket!.send(JSON.stringify({ id, method, params, ...(sessionID ? { sessionId: sessionID } : {}) }))
    })
  }
  if (values.session) {
    socket = new WebSocket(`ws://127.0.0.1:19989/devtools/browser/recording-benchmark?browserControlSessionId=${encodeURIComponent(values.session)}`)
    socket.on("message", (raw) => {
      const event = getObject(JSON.parse(raw.toString()))!
      if (typeof event.id === "number") {
        const request = pending.get(event.id)
        pending.delete(event.id)
        if (event.error) request?.reject(new Error(JSON.stringify(event.error)))
        else request?.resolve(getObject(event.result) ?? {})
      }
      if (event.method === "Page.screencastFrame") recordingRelay?.handleDebuggerEvent({ tabId: 1, method: event.method, params: getObject(event.params) })
    })
    socket.on("close", () => { for (const request of pending.values()) request.reject(new Error("CDP benchmark disconnected")); pending.clear() })
    await once(socket, "open")
    const targets = await send("Target.getTargets", {})
    if (!Array.isArray(targets.targetInfos) || targets.targetInfos.length !== 1) throw new Error("Expected one raw target")
    const attached = await send("Target.attachToTarget", { targetId: getObject(targets.targetInfos[0])!.targetId!, flatten: true })
    if (typeof attached.sessionId !== "string") throw new Error("Missing raw session id")
    sessionID = attached.sessionId
    await send("Page.enable", {})
  }
  await page.evaluate(() => document.fonts.ready)
  if (values["backing-surface"]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false, dontSetVisibleSize: true })
    const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })
    if (typeof screenshot.data !== "string") throw new Error("Missing reference screenshot")
    await fs.writeFile(path.join(directory, "reference.png"), Buffer.from(screenshot.data, "base64"))
  } else {
    await page.screenshot({ path: path.join(directory, "reference.png"), scale: "css" })
  }
  const relay = new RecordingRelay({
    isExtensionConnected: () => true,
    sendToExtension: async () => { throw new Error("Unexpected extension call") },
    sendDebuggerCommand: ({ method, params }) => send(method, params),
  })
  recordingRelay = relay
  if (!values.session) cdp.on("Page.screencastFrame", (params) => relay.handleDebuggerEvent({ tabId: 1, method: "Page.screencastFrame", params: getObject(params) }))
  for (let index = 0; index <= runs; index++) {
    const output = path.join(directory, `${index}.${values.format}`)
    const started = await relay.startRecording({ tabId: 1, owner: "relay", outputPath: output, mode: "cdp" })
    if (!started.success) throw new Error(started.error)
    await page.waitForTimeout(2200)
    const stopped = await relay.stopRecording({ tabId: 1 })
    if (!stopped.success) throw new Error(stopped.error)
    const metadata = JSON.parse(await fs.readFile(`${output}.json`, "utf8"))
    if (metadata.sourceFrameCount < 2) throw new Error("Moving fixture received no compositor stream; screenshot fallback is not motion proof")
    const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,r_frame_rate:format=duration,size", "-of", "json", output]).stdout.toString())
    const frame = path.join(directory, `${index}.png`)
    run("ffmpeg", ["-v", "error", "-ss", "0.5", "-i", output, "-frames:v", "1", frame])
    // Normalize to the intended CSS viewport for comparison, not for the delivered recording.
    const comparison = run("ffmpeg", ["-i", path.join(directory, "reference.png"), "-i", frame, "-lavfi",
      `[0:v]crop=800:220:64:64,format=yuv444p[a];[1:v]scale=${width}:${height}:flags=lanczos,crop=800:220:64:64,format=yuv444p[b];[a][b]ssim`, "-f", "null", "-"])
    const ssim = Number(comparison.stderr.toString().match(/All:([\d.]+)/)?.[1])
    if (!Number.isFinite(ssim)) throw new Error("No SSIM result")
    const motion = run("ffmpeg", ["-v", "error", "-i", output, "-vf", `scale=${width}:${height},crop=${width - 96}:1:48:${height - 90},format=gray`, "-f", "rawvideo", "-"]).stdout
    const stride = width - 96
    const positions = Array.from({ length: Math.floor(motion.length / stride) }, (_, i) => motion.subarray(i * stride, (i + 1) * stride).findIndex((pixel) => pixel > 220))
    const changes = positions.filter((position, i) => i > 0 && position >= 0 && position !== positions[i - 1]).length
    const result = {
      run: index, warmup: index === 0, textSSIM: ssim,
      distinctMotionFps: changes / Number(probe.format.duration),
      encodedSourceFps: metadata.encodedSourceFrameCount / (metadata.durationMs / 1000),
      droppedFrames: metadata.droppedFrameCount,
      outputWidth: probe.streams[0].width, outputHeight: probe.streams[0].height,
      bytes: Number(probe.format.size), duration: Number(probe.format.duration),
    }
    console.log(JSON.stringify(result))
    if (index > 0) results.push(result)
  }
  await fs.writeFile(path.join(directory, "results.json"), JSON.stringify({ width, height, dpr: Number(values.dpr), results }, null, 2))
  for (const key of ["textSSIM", "distinctMotionFps", "encodedSourceFps", "bytes"] as const) {
    const samples = results.map((row) => row[key]).sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length / 2)]!
    console.log(`METRIC recording_${key}=${median.toFixed(6)} min=${samples[0]} max=${samples.at(-1)}`)
  }
  if (values.verify && results.some((row) => row.textSSIM < 0.98 || row.distinctMotionFps < 45 || row.droppedFrames !== 0 || row.outputWidth !== width || row.outputHeight !== height)) {
    throw new Error("Recording quality regression: require SSIM>=0.98, >=45 actual motion changes/s, native dimensions, and no dropped frames")
  }
} finally {
  if (recordingRelay?.hasActiveRecordings()) await recordingRelay.cancelRecording({ tabId: 1 })
  socket?.close()
  // connectOverCDP.close disconnects this client; it does not close the attached browser.
  await browser.close()
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr.toString()}`)
  return result
}
