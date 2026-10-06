const handleInput = document.querySelector("#handle-input")
const tabCourse = document.querySelector("#tab-course")
const tabLab = document.querySelector("#tab-lab")
const viewCourse = document.querySelector("#view-course")
const viewLab = document.querySelector("#view-lab")
const liveCountEl = document.querySelector("#live-count")

const stagePills = Array.from(document.querySelectorAll(".stage-pill"))
const hudStep = document.querySelector("#hud-step")
const hudHz = document.querySelector("#hud-hz")
const hudDevice = document.querySelector("#hud-device")
const hudTimer = document.querySelector("#hud-timer")
const restartBtn = document.querySelector("#restart-btn")

const arena = document.querySelector("#arena")
const arenaCanvas = document.querySelector("#arena-canvas")
const arenaStage = document.querySelector("#arena-stage")

const profileFilters = document.querySelector("#profile-filters")
const modelSampleBadge = document.querySelector("#model-sample-badge")
const modelSourceLabel = document.querySelector("#model-source-label")
const copyCliBtn = document.querySelector("#copy-cli-btn")
const copyJsonBtn = document.querySelector("#copy-json-btn")
const newRunBtn = document.querySelector("#new-run-btn")
const pathsCanvas = document.querySelector("#paths-canvas")
const velocityCanvas = document.querySelector("#velocity-canvas")
const peakULabel = document.querySelector("#peak-u-label")
const comparatorBox = document.querySelector("#comparator-box")
const comparatorCanvas = document.querySelector("#comparator-canvas")
const autoRaceToggle = document.querySelector("#auto-race-toggle")
const paramsList = document.querySelector("#params-list")
const rosterList = document.querySelector("#roster-list")
const rosterCountLabel = document.querySelector("#roster-count-label")
const traceCaption = document.querySelector("#trace-caption")

// Persistent handle & device selection
const rawSavedHandle = localStorage.getItem("bc_calibration_handle") || ""
const savedHandle = rawSavedHandle === "agent-verify" ? "kit" : rawSavedHandle
if (rawSavedHandle === "agent-verify") {
  localStorage.setItem("bc_calibration_handle", "kit")
}
handleInput.value = savedHandle
handleInput.addEventListener("input", () => {
  localStorage.setItem("bc_calibration_handle", handleInput.value.trim())
})

let deviceOverride = "auto"
let detectedDevice = "trackpad"
let selectedDeviceFilter = "all"

function syncDeviceSegmented(device) {
  for (const b of document.querySelectorAll(".segmented .seg")) {
    b.classList.toggle("active", b.dataset.device === device)
  }
}

for (const btn of document.querySelectorAll(".segmented .seg")) {
  btn.addEventListener("click", () => {
    deviceOverride = btn.dataset.device || "auto"
    syncDeviceSegmented(deviceOverride)
    updateHud()
  })
}

function effectiveDevice() {
  return deviceOverride === "auto" ? detectedDevice : deviceOverride
}

// High-frequency pointer and input telemetry state
let courseStartedAt = 0
let currentStage = 0
let completedSteps = 0
const totalSteps = 21

let lastAnchor = null
let activeBuffer = []
let interSampleDeltas = []
let estimatedHz = 60
let pendingDown = null

let recordedReaches = []
let recordedScrolls = []
let recordedKeys = []

let activeScrollBurst = null
let scrollBurstTimer = null
const keyDownTimes = new Map()
let lastKeyDownAt = 0
let lastKeyUpAt = 0

// Visual trail on arena canvas
const trailPoints = []
const clickRipples = []

// Server state & active run inspection
let serverState = null
let selectedHandleFilter = "all"
let inspectedReaches = []
let inspectedReachAnalyses = []
let inspectedKeys = []
let inspectedRunLabel = "Current session"
let activeSubchart = "velocity"

for (const btn of document.querySelectorAll(".mini-tab")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".mini-tab")) b.classList.remove("active")
    btn.classList.add("active")
    activeSubchart = btn.dataset.subchart || "velocity"
    drawVelocityProfile()
  })
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v))
}

function round(v, d = 2) {
  const f = 10 ** d
  return Math.round(v * f) / f
}

function arenaPoint(clientX, clientY) {
  const rect = arena.getBoundingClientRect()
  return {
    x: round(clientX - rect.left, 1),
    y: round(clientY - rect.top, 1),
  }
}

// Track all pointer movements with getCoalescedEvents()
arena.addEventListener("pointermove", (event) => {
  const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event]
  const samples = events.length > 0 ? events : [event]
  for (const sample of samples) {
    const pt = arenaPoint(sample.clientX, sample.clientY)
    const t = sample.timeStamp || performance.now()
    if (activeBuffer.length > 0) {
      const prev = activeBuffer[activeBuffer.length - 1]
      const dt = t - prev.t
      if (dt > 0.4 && dt < 50) {
        interSampleDeltas.push(dt)
        if (interSampleDeltas.length > 160) interSampleDeltas.shift()
        const sorted = [...interSampleDeltas].sort((a, b) => a - b)
        const med = sorted[Math.floor(sorted.length / 2)] || 16.6
        estimatedHz = clamp(Math.round(1000 / med), 30, 1000)
      }
    }
    activeBuffer.push({ x: pt.x, y: pt.y, t })
    if (activeBuffer.length > 420) activeBuffer.shift()
    trailPoints.push({ x: pt.x, y: pt.y, at: performance.now() })
  }
  if (trailPoints.length > 140) trailPoints.splice(0, trailPoints.length - 140)
})

arena.addEventListener("pointerdown", (event) => {
  const pt = arenaPoint(event.clientX, event.clientY)
  const now = event.timeStamp || performance.now()
  if (!courseStartedAt) courseStartedAt = performance.now()
  pendingDown = {
    x: pt.x,
    y: pt.y,
    at: now,
    bufferSnapshot: [...activeBuffer, { x: pt.x, y: pt.y, t: now }],
  }
  clickRipples.push({ x: pt.x, y: pt.y, at: performance.now() })
})

window.addEventListener("pointerup", (event) => {
  if (!pendingDown) return
  const pt = arenaPoint(event.clientX, event.clientY)
  const now = event.timeStamp || performance.now()
  pendingDown.upAt = now
  pendingDown.upPoint = pt
})

arena.addEventListener(
  "wheel",
  (event) => {
    const now = performance.now()
    const pt = arenaPoint(event.clientX, event.clientY)
    lastAnchor = pt
    activeBuffer = [{ x: pt.x, y: pt.y, t: now }]
    if (Math.abs(event.deltaX) > 0 || !Number.isInteger(event.deltaY) || Math.abs(event.deltaY) < 40) {
      detectedDevice = "trackpad"
    }
    if (!activeScrollBurst) {
      activeScrollBurst = {
        startedAt: now,
        lastAt: now,
        totalDeltaX: 0,
        totalDeltaY: 0,
        frames: [],
      }
    }
    const dt = Math.max(1, round(now - activeScrollBurst.lastAt, 1))
    activeScrollBurst.lastAt = now
    activeScrollBurst.totalDeltaX = round(activeScrollBurst.totalDeltaX + event.deltaX, 1)
    activeScrollBurst.totalDeltaY = round(activeScrollBurst.totalDeltaY + event.deltaY, 1)
    if (activeScrollBurst.frames.length < 48) {
      activeScrollBurst.frames.push({
        dx: round(event.deltaX, 1),
        dy: round(event.deltaY, 1),
        dt,
      })
    }
    clearTimeout(scrollBurstTimer)
    scrollBurstTimer = setTimeout(() => {
      if (activeScrollBurst && activeScrollBurst.frames.length >= 2) {
        recordedScrolls.push({
          totalDeltaX: activeScrollBurst.totalDeltaX,
          totalDeltaY: activeScrollBurst.totalDeltaY,
          durationMs: Math.max(16, Math.round(activeScrollBurst.lastAt - activeScrollBurst.startedAt)),
          frameCount: activeScrollBurst.frames.length,
          frames: activeScrollBurst.frames,
        })
      }
      activeScrollBurst = null
    }, 140)
  },
  { passive: true },
)

function recordTargetAcquisition(targetEl, stageLabel, overrideFromPoint = null) {
  const rect = targetEl.getBoundingClientRect()
  const arenaRect = arena.getBoundingClientRect()
  const targetCenter = {
    x: round(rect.left - arenaRect.left + rect.width / 2, 1),
    y: round(rect.top - arenaRect.top + rect.height / 2, 1),
  }
  const now = performance.now()
  const down = pendingDown || {
    x: targetCenter.x,
    y: targetCenter.y,
    at: now - 45,
    bufferSnapshot: [...activeBuffer],
  }
  const to = down.upPoint && stageLabel === "drag" ? down.upPoint : { x: down.x, y: down.y }
  const from = overrideFromPoint || lastAnchor || (down.bufferSnapshot[0] ? { x: down.bufferSnapshot[0].x, y: down.bufferSnapshot[0].y } : { x: to.x - 180, y: to.y - 90 })

  // Trim leading idle samples before cursor actually departed `from`
  const raw = down.bufferSnapshot.length > 1 ? down.bufferSnapshot : [{ x: from.x, y: from.y, t: down.at - 180 }, { x: to.x, y: to.y, t: down.at }]
  let startIndex = 0
  for (let i = raw.length - 2; i >= 0; i--) {
    const dFromStart = Math.hypot(raw[i].x - from.x, raw[i].y - from.y)
    if (dFromStart < 4) {
      startIndex = i
      break
    }
  }
  const flight = raw.slice(startIndex)
  const t0 = flight[0]?.t ?? down.at - 180
  const tEnd = flight[flight.length - 1]?.t ?? down.at
  const durationMs = clamp(Math.round(tEnd - t0), 40, 2200)

  // Compute settle time (time spent within 5.5px of `to` before pointerdown)
  let enteredNearAt = tEnd
  for (let i = flight.length - 1; i >= 0; i--) {
    if (Math.hypot(flight[i].x - to.x, flight[i].y - to.y) <= 5.5) {
      enteredNearAt = flight[i].t
    } else {
      break
    }
  }
  const settleMs = clamp(Math.round(tEnd - enteredNearAt), 6, 220)
  const holdMs = clamp(Math.round((down.upAt || performance.now()) - down.at), 20, 240)

  // Subsample to <= 72 samples while preserving endpoints
  const stride = Math.max(1, Math.ceil(flight.length / 72))
  const samples = flight
    .filter((_, idx) => idx === 0 || idx === flight.length - 1 || idx % stride === 0)
    .map((s) => ({
      x: round(s.x, 1),
      y: round(s.y, 1),
      t: round(s.t - t0, 1),
    }))

  if (Math.hypot(to.x - from.x, to.y - from.y) >= 18 && samples.length >= 4) {
    recordedReaches.push({
      from,
      to,
      targetCenter,
      targetWidth: round(rect.width, 1),
      targetHeight: round(rect.height, 1),
      durationMs,
      settleMs,
      holdMs,
      samples,
      stage: stageLabel,
    })
    inspectedReaches = [...recordedReaches]
    inspectedRunLabel = `@${handleInput.value.trim() || "anon"} (live)`
  }

  lastAnchor = to
  activeBuffer = [{ x: to.x, y: to.y, t: performance.now() }]
  pendingDown = null
}

// Stage definitions
const fittsLayout = [
  { rx: 0.18, ry: 0.24, size: 52 },
  { rx: 0.82, ry: 0.28, size: 34 },
  { rx: 0.24, ry: 0.76, size: 64 },
  { rx: 0.76, ry: 0.72, size: 26 },
  { rx: 0.5, ry: 0.18, size: 42 },
  { rx: 0.14, ry: 0.52, size: 30 },
  { rx: 0.86, ry: 0.5, size: 48 },
  { rx: 0.48, ry: 0.82, size: 28 },
]

const menuSpecs = [
  {
    rx: 0.22,
    ry: 0.22,
    label: "Select region",
    items: ["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1", "sa-east-1"],
    targetIndex: 1,
  },
  {
    rx: 0.74,
    ry: 0.24,
    label: "Target branch",
    items: ["main", "dev", "origin/v2", "release/0.8", "feat/cursor"],
    targetIndex: 2,
  },
  {
    rx: 0.26,
    ry: 0.56,
    label: "Runtime engine",
    items: ["node-22", "bun-1.4", "workerd", "deno-2", "quickjs"],
    targetIndex: 2,
  },
  {
    rx: 0.7,
    ry: 0.54,
    label: "Motion profile",
    items: ["linear", "minimum-jerk", "woodworth-meyer", "spring-rk4", "step"],
    targetIndex: 2,
  },
]

const scrollSpecs = [
  { targetRow: 38, actionLabel: "Rotate key" },
  { targetRow: 7, actionLabel: "Verify hash" },
]

const dragSpecs = [
  { fromRx: 0.22, fromRy: 0.35, toRx: 0.76, toRy: 0.65 },
  { fromRx: 0.78, fromRy: 0.3, toRx: 0.25, toRy: 0.72 },
]

function resetCourse() {
  courseStartedAt = 0
  currentStage = 0
  completedSteps = 0
  lastAnchor = null
  activeBuffer = []
  recordedReaches = []
  recordedScrolls = []
  recordedKeys = []
  updateHud()
  renderStartCard()
}

function renderStartCard() {
  arenaStage.innerHTML = ""
  const card = document.createElement("div")
  card.className = "start-card"
  const currentHandle = (handleInput.value || "").replace(/"/g, "")
  card.innerHTML = `
    <label class="cadence-field">
      <span>Handle</span>
      <input id="start-handle-input" type="text" maxlength="24" autocomplete="off" spellcheck="false" placeholder="slack handle (e.g. kit)" value="${currentHandle}" />
    </label>
    <div class="start-buttons">
      <button type="button" class="start-device-btn" data-start-device="trackpad">
        <span>Trackpad</span>
        <small>Start 40s course</small>
      </button>
      <button type="button" class="start-device-btn" data-start-device="mouse">
        <span>Mouse</span>
        <small>Start 40s course</small>
      </button>
    </div>
  `
  arenaStage.appendChild(card)

  const startInput = card.querySelector("#start-handle-input")
  startInput.addEventListener("input", () => {
    handleInput.value = startInput.value.trim()
    localStorage.setItem("bc_calibration_handle", handleInput.value)
  })
  if (!currentHandle) {
    setTimeout(() => startInput.focus(), 30)
  }

  for (const btn of card.querySelectorAll(".start-device-btn")) {
    btn.addEventListener("click", (e) => {
      const chosen = btn.dataset.startDevice || "trackpad"
      detectedDevice = chosen
      deviceOverride = chosen
      syncDeviceSegmented(chosen)
      if (startInput.value.trim()) {
        handleInput.value = startInput.value.trim()
        localStorage.setItem("bc_calibration_handle", handleInput.value)
      }
      courseStartedAt = performance.now()
      lastAnchor = arenaPoint(e.clientX, e.clientY)
      activeBuffer = [{ x: lastAnchor.x, y: lastAnchor.y, t: performance.now() }]
      pendingDown = null
      updateHud()
      renderFittsStage(0)
    })
  }
}

function updateHud() {
  hudStep.textContent = `${completedSteps} / ${totalSteps}`
  hudHz.textContent = `${estimatedHz} Hz`
  hudDevice.textContent = effectiveDevice()
  const elapsed = courseStartedAt ? ((performance.now() - courseStartedAt) / 1000).toFixed(1) : "0.0"
  hudTimer.textContent = `${elapsed}s`
  stagePills.forEach((pill, idx) => {
    pill.classList.toggle("active", idx === currentStage)
    pill.classList.toggle("done", idx < currentStage)
  })
}

setInterval(() => {
  if (courseStartedAt && viewCourse.classList.contains("active")) {
    updateHud()
  }
}, 100)

// STAGE 1: Fitts's Ballistic Reach
function renderFittsStage(index) {
  currentStage = 0
  updateHud()
  arenaStage.innerHTML = ""
  if (index >= fittsLayout.length) {
    renderMenuStage(0)
    return
  }
  const rect = arena.getBoundingClientRect()
  const spec = fittsLayout[index]
  const nextSpec = fittsLayout[index + 1]

  if (nextSpec) {
    const ghost = document.createElement("div")
    ghost.className = "fitts-ghost"
    ghost.style.left = `${Math.round(nextSpec.rx * rect.width)}px`
    ghost.style.top = `${Math.round(nextSpec.ry * rect.height)}px`
    ghost.style.width = `${nextSpec.size}px`
    ghost.style.height = `${nextSpec.size}px`
    ghost.textContent = String(index + 2)
    arenaStage.appendChild(ghost)
  }

  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "fitts-target"
  btn.style.left = `${Math.round(spec.rx * rect.width)}px`
  btn.style.top = `${Math.round(spec.ry * rect.height)}px`
  btn.style.width = `${spec.size}px`
  btn.style.height = `${spec.size}px`
  btn.textContent = String(index + 1)

  btn.addEventListener("click", () => {
    recordTargetAcquisition(btn, "fitts")
    completedSteps += 1
    renderFittsStage(index + 1)
  })
  arenaStage.appendChild(btn)
}

// STAGE 2: Dropdown Menus
function renderMenuStage(index) {
  currentStage = 1
  updateHud()
  arenaStage.innerHTML = ""
  if (index >= menuSpecs.length) {
    renderScrollStage(0)
    return
  }
  const rect = arena.getBoundingClientRect()
  const spec = menuSpecs[index]
  const unit = document.createElement("div")
  unit.className = "menu-unit"
  unit.style.left = `${Math.round(spec.rx * (rect.width - 220))}px`
  unit.style.top = `${Math.round(spec.ry * (rect.height - 220))}px`

  const trigger = document.createElement("button")
  trigger.type = "button"
  trigger.className = "menu-trigger waiting"
  trigger.innerHTML = `<span>${spec.label}</span><span>▾</span>`
  unit.appendChild(trigger)

  trigger.addEventListener(
    "click",
    () => {
      recordTargetAcquisition(trigger, "menu-open")
      completedSteps += 1
      updateHud()
      trigger.classList.remove("waiting")
      const pop = document.createElement("div")
      pop.className = "menu-popover"
      spec.items.forEach((itemText, itemIdx) => {
        const row = document.createElement("button")
        row.type = "button"
        const isTarget = itemIdx === spec.targetIndex
        row.className = isTarget ? "menu-item target-row" : "menu-item"
        row.innerHTML = `<span>${itemText}</span><span>${isTarget ? "←" : ""}</span>`
        row.addEventListener("click", () => {
          if (!isTarget) return
          recordTargetAcquisition(row, "menu-select")
          completedSteps += 1
          renderMenuStage(index + 1)
        })
        pop.appendChild(row)
      })
      unit.appendChild(pop)
    },
    { once: true },
  )

  arenaStage.appendChild(unit)
}

// STAGE 3: Scroll & Acquire
function renderScrollStage(index) {
  currentStage = 2
  updateHud()
  arenaStage.innerHTML = ""
  if (index >= scrollSpecs.length) {
    renderDragStage(0)
    return
  }
  const spec = scrollSpecs[index]
  const card = document.createElement("div")
  card.className = "scroll-card"
  card.innerHTML = `
    <div class="scroll-header">
      <span>Scroll to <strong>Row #${String(spec.targetRow).padStart(2, "0")}</strong></span>
      <span>${index + 1} / ${scrollSpecs.length}</span>
    </div>
  `
  const list = document.createElement("div")
  list.className = "scroll-list"

  for (let i = 1; i <= 48; i++) {
    const isTarget = i === spec.targetRow
    const row = document.createElement("div")
    row.className = isTarget ? "scroll-row target" : "scroll-row"
    row.innerHTML = `<span>Row #${String(i).padStart(2, "0")} · session-${(i * 17).toString(16)}</span>`
    const btn = document.createElement("button")
    btn.type = "button"
    btn.textContent = isTarget ? spec.actionLabel : "Inspect"
    btn.addEventListener("click", () => {
      if (!isTarget) return
      recordTargetAcquisition(btn, "scroll-acquire")
      completedSteps += 1
      renderScrollStage(index + 1)
    })
    row.appendChild(btn)
    list.appendChild(row)
  }

  card.appendChild(list)
  arenaStage.appendChild(card)
  if (index === 1) {
    list.scrollTop = list.scrollHeight
  }
}

// STAGE 4: Drag Token to Slot
function renderDragStage(index) {
  currentStage = 3
  updateHud()
  arenaStage.innerHTML = ""
  if (index >= dragSpecs.length) {
    renderCadenceStage()
    return
  }
  const rect = arena.getBoundingClientRect()
  const spec = dragSpecs[index]
  const startX = Math.round(spec.fromRx * rect.width)
  const startY = Math.round(spec.fromRy * rect.height)
  const slotX = Math.round(spec.toRx * rect.width)
  const slotY = Math.round(spec.toRy * rect.height)

  const slot = document.createElement("div")
  slot.className = "drop-slot"
  slot.style.left = `${slotX}px`
  slot.style.top = `${slotY}px`
  slot.textContent = "Drop"
  arenaStage.appendChild(slot)

  const token = document.createElement("div")
  token.className = "drag-token"
  token.style.left = `${startX}px`
  token.style.top = `${startY}px`
  token.textContent = "Drag"
  arenaStage.appendChild(token)

  let dragging = false
  let dragOrigin = { x: startX, y: startY }

  token.addEventListener("pointerdown", (e) => {
    dragging = true
    dragOrigin = arenaPoint(e.clientX, e.clientY)
    recordTargetAcquisition(token, "drag-grab")
    activeBuffer = [{ x: dragOrigin.x, y: dragOrigin.y, t: performance.now() }]
    token.setPointerCapture(e.pointerId)
  })

  token.addEventListener("pointermove", (e) => {
    if (!dragging) return
    const pt = arenaPoint(e.clientX, e.clientY)
    token.style.left = `${pt.x}px`
    token.style.top = `${pt.y}px`
  })

  token.addEventListener("pointerup", (e) => {
    if (!dragging) return
    dragging = false
    const pt = arenaPoint(e.clientX, e.clientY)
    const now = e.timeStamp || performance.now()
    if (Math.hypot(pt.x - slotX, pt.y - slotY) <= 44) {
      pendingDown = {
        x: pt.x,
        y: pt.y,
        at: now,
        upAt: now,
        upPoint: pt,
        bufferSnapshot: [...activeBuffer, { x: pt.x, y: pt.y, t: now }],
      }
      recordTargetAcquisition(slot, "drag", dragOrigin)
      completedSteps += 1
      renderDragStage(index + 1)
    } else {
      token.style.left = `${startX}px`
      token.style.top = `${startY}px`
    }
  })
}

// STAGE 5: Form Cadence & Submit
function renderCadenceStage() {
  currentStage = 4
  updateHud()
  arenaStage.innerHTML = ""

  const phrase = "ship browser control"
  const pin = "4829"

  const card = document.createElement("form")
  card.className = "cadence-card"
  card.innerHTML = `
    <label class="cadence-field">
      <span>Handle</span>
      <input id="cadence-handle" type="text" autocomplete="off" spellcheck="false" placeholder="your slack handle (e.g. vogel)" value="${(handleInput.value || "").replace(/"/g, "")}" />
    </label>
    <label class="cadence-field">
      <span>Type <code>${phrase}</code></span>
      <input id="cadence-input-1" type="text" autocomplete="off" spellcheck="false" placeholder="${phrase}" />
    </label>
    <label class="cadence-field">
      <span>Code <code>${pin}</code></span>
      <input id="cadence-input-2" type="text" autocomplete="off" spellcheck="false" placeholder="${pin}" />
    </label>
    <button type="submit" id="cadence-submit" class="primary-btn">Finish &amp; Fit Model</button>
  `
  arenaStage.appendChild(card)

  const cadenceHandle = card.querySelector("#cadence-handle")
  cadenceHandle.addEventListener("input", () => {
    handleInput.value = cadenceHandle.value.trim()
    localStorage.setItem("bc_calibration_handle", handleInput.value)
  })
  const input1 = card.querySelector("#cadence-input-1")
  const input2 = card.querySelector("#cadence-input-2")
  const submitBtn = card.querySelector("#cadence-submit")

  for (const inp of [input1, input2]) {
    inp.addEventListener("pointerdown", () => {
      setTimeout(() => recordTargetAcquisition(inp, "form-focus"), 0)
    })
    inp.addEventListener("keydown", (e) => {
      const now = e.timeStamp || performance.now()
      if (e.key.length === 1) {
        const ikiMs = lastKeyDownAt > 0 ? clamp(Math.round(now - lastKeyDownAt), 8, 900) : 0
        const rolloverMs = lastKeyUpAt > 0 ? Math.round(lastKeyUpAt - now) : 0
        keyDownTimes.set(e.key.toLowerCase(), { downAt: now, ikiMs, rolloverMs })
        lastKeyDownAt = now
      }
    })
    inp.addEventListener("keyup", (e) => {
      const now = e.timeStamp || performance.now()
      lastKeyUpAt = now
      const entry = keyDownTimes.get(e.key.toLowerCase())
      if (entry && entry.ikiMs > 0) {
        recordedKeys.push({
          key: e.key.toLowerCase(),
          holdMs: clamp(Math.round(now - entry.downAt), 12, 360),
          ikiMs: entry.ikiMs,
          rolloverMs: entry.rolloverMs,
        })
        keyDownTimes.delete(e.key.toLowerCase())
      }
    })
  }

  card.addEventListener("submit", async (e) => {
    e.preventDefault()
    if (input1.value.trim().length < 3) {
      input1.focus()
      return
    }
    if (input2.value.trim().length < 2) {
      input2.focus()
      return
    }
    recordTargetAcquisition(submitBtn, "form-submit")
    completedSteps = totalSteps
    updateHud()
    await submitCompletedRun()
  })
}

async function submitCompletedRun() {
  const handle = (handleInput.value || "").trim() || "anon"
  const courseTimeMs = courseStartedAt ? Math.round(performance.now() - courseStartedAt) : 30000
  const payload = {
    handle,
    device: effectiveDevice(),
    sampleRateHz: estimatedHz,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    },
    courseTimeMs,
    reaches: recordedReaches,
    scrolls: recordedScrolls,
    keys: recordedKeys,
  }

  switchView("lab")

  try {
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.state) {
        applyServerState(data.state)
      }
    }
  } catch {
    // Offline fallback keeps local visualization active
  }
}

// Arena background trail loop
function renderArenaOverlay() {
  if (viewCourse.classList.contains("active")) {
    const dpr = window.devicePixelRatio || 1
    const w = arena.clientWidth
    const h = arena.clientHeight
    if (arenaCanvas.width !== w * dpr || arenaCanvas.height !== h * dpr) {
      arenaCanvas.width = w * dpr
      arenaCanvas.height = h * dpr
    }
    const ctx = arenaCanvas.getContext("2d")
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const now = performance.now()
    while (trailPoints.length > 0 && now - trailPoints[0].at > 550) {
      trailPoints.shift()
    }
    if (trailPoints.length > 1) {
      for (let i = 1; i < trailPoints.length; i++) {
        const p0 = trailPoints[i - 1]
        const p1 = trailPoints[i]
        const age = clamp(1 - (now - p1.at) / 550, 0, 1)
        ctx.strokeStyle = `rgba(240, 77, 48, ${(age * 0.55).toFixed(3)})`
        ctx.lineWidth = 1.75
        ctx.beginPath()
        ctx.moveTo(p0.x, p0.y)
        ctx.lineTo(p1.x, p1.y)
        ctx.stroke()
      }
    }

    while (clickRipples.length > 0 && now - clickRipples[0].at > 420) {
      clickRipples.shift()
    }
    for (const r of clickRipples) {
      const u = clamp((now - r.at) / 420, 0, 1)
      ctx.strokeStyle = `rgba(236, 235, 227, ${(1 - u) * 0.55})`
      ctx.lineWidth = (1 - u) * 2.2
      ctx.beginPath()
      ctx.arc(r.x, r.y, 4 + u * 22, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  requestAnimationFrame(renderArenaOverlay)
}
requestAnimationFrame(renderArenaOverlay)

// View switching
function switchView(mode) {
  const isLab = mode === "lab"
  tabCourse.classList.toggle("active", !isLab)
  tabLab.classList.toggle("active", isLab)
  tabCourse.setAttribute("aria-selected", String(!isLab))
  tabLab.setAttribute("aria-selected", String(isLab))
  viewCourse.classList.toggle("active", !isLab)
  viewLab.classList.toggle("active", isLab)
  if (isLab) {
    renderLabVisuals()
  }
}

tabCourse.addEventListener("click", () => switchView("course"))
tabLab.addEventListener("click", () => switchView("lab"))
restartBtn.addEventListener("click", () => resetCourse())
newRunBtn.addEventListener("click", () => {
  resetCourse()
  switchView("course")
})

// Fetch & live-sync server state
async function fetchState(handle = selectedHandleFilter, device = selectedDeviceFilter) {
  selectedHandleFilter = handle
  selectedDeviceFilter = device
  const params = new URLSearchParams()
  if (handle && handle !== "all") params.set("handle", handle)
  if (device && device !== "all") params.set("device", device)
  const res = await fetch(`/api/state?${params.toString()}`)
  if (!res.ok) return
  const state = await res.json()
  applyServerState(state)
  if (inspectedReaches.length === 0 && state.recentRuns?.length > 0) {
    await inspectRunById(state.recentRuns[0].id)
  }
}

async function inspectRunById(runId) {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`)
  if (!res.ok) return
  const data = await res.json()
  if (data.run?.reaches) {
    inspectedReaches = data.run.reaches
    inspectedReachAnalyses = data.reachAnalyses || []
    inspectedKeys = data.run.keys || []
    inspectedRunLabel = `@${data.run.handle} · ${data.run.device} · ${data.run.sampleRateHz}Hz`
    renderLabVisuals()
  }
}

function applyServerState(state) {
  serverState = state
  if (typeof state.activeViewers === "number") {
    liveCountEl.textContent = `${Math.max(1, state.activeViewers)} online`
  }
  renderFilterChips(state)
  renderParameters(state.model)
  renderRoster(state)
  renderLabVisuals()
}

function renderFilterChips(state) {
  profileFilters.innerHTML = ""
  const allChip = document.createElement("button")
  allChip.type = "button"
  allChip.className = `filter-chip ${selectedHandleFilter === "all" && selectedDeviceFilter === "all" ? "active" : ""}`
  allChip.textContent = `Team (${state.totals.runs})`
  allChip.addEventListener("click", () => fetchState("all", "all"))
  profileFilters.appendChild(allChip)

  for (const dev of ["trackpad", "mouse"]) {
    const devChip = document.createElement("button")
    devChip.type = "button"
    devChip.className = `filter-chip ${selectedDeviceFilter === dev && selectedHandleFilter === "all" ? "active" : ""}`
    devChip.textContent = dev
    devChip.addEventListener("click", () => fetchState("all", dev))
    profileFilters.appendChild(devChip)
  }

  for (const person of state.roster) {
    const chip = document.createElement("button")
    chip.type = "button"
    chip.className = `filter-chip ${selectedHandleFilter === person.handle ? "active" : ""}`
    chip.textContent = `@${person.handle} (${person.runs})`
    chip.addEventListener("click", () => fetchState(person.handle, "all"))
    profileFilters.appendChild(chip)
  }
}

function renderParameters(model) {
  if (!model) return
  modelSampleBadge.textContent = `${model.sampleCount.runs} runs · ${model.sampleCount.reaches} reaches`
  modelSourceLabel.textContent = model.source
  peakULabel.textContent = String(model.reach.peakVelocityU)

  const items = [
    ["Throughput", `${model.reach.throughputBps} bps`],
    ["Ballistic γ", `${model.reach.ballisticExponent}`],
    ["Peak speed u", `${Math.round(model.reach.peakVelocityU * 100)}%`],
    ["Fitts a / b", `${model.reach.fittsAMs} / ${model.reach.fittsBMsPerBit}ms`],
    ["Duration √D", `${model.reach.baseMs} + ${model.reach.sqrtScale}√D`],
    ["Path ratio", `${model.reach.pathRatioMedian}×`],
    ["Arc bow", `${Math.round(model.reach.bowMinRatio * 1000) / 10}–${Math.round(model.reach.bowMaxRatio * 1000) / 10}%`],
    ["Wrist bias", `${model.reach.wristBias}`],
    ["Overshoot", `${Math.round(model.submovements.overshootRate * 100)}% (${model.submovements.overshootMinPx}–${model.submovements.overshootMaxPx}px)`],
    ["Undershoot", `${Math.round(model.submovements.undershootRate * 100)}%`],
    ["Tremor band", `${model.tremor.freq1MinHz}–${model.tremor.freq1MaxHz} Hz`],
    ["Aim scatter", `±${model.click.aimSigmaX} / ±${model.click.aimSigmaY}px`],
    ["Click settle", `${model.click.settleMinMs}–${model.click.settleMaxMs}ms`],
    ["Click hold", `${model.click.holdMinMs}–${model.click.holdMaxMs}ms`],
    ["Key cadence", `${model.keyboard.gapMinMs}–${model.keyboard.gapMaxMs}ms`],
    ["Key rollover", `${Math.round(model.keyboard.rolloverRate * 100)}%`],
  ]

  paramsList.innerHTML = items
    .map(([k, v]) => `<div class="param-row"><span>${k}</span><strong>${v}</strong></div>`)
    .join("")
}

function renderRoster(state) {
  rosterCountLabel.textContent = `${state.roster.length} people · ${state.totals.runs} runs`
  rosterList.innerHTML = ""
  state.roster.forEach((person, idx) => {
    const item = document.createElement("div")
    item.className = `roster-item ${selectedHandleFilter === person.handle ? "selected" : ""}`
    item.innerHTML = `
      <div>
        <strong>#${idx + 1} @${person.handle}</strong>
        <span class="meta-label"> · ${person.device} (${person.runs})</span>
      </div>
      <div class="roster-meta">
        <span>${person.throughputBps} bps</span>
        <span>u=${person.peakVelocityU}</span>
        <span>${(person.bestTimeMs / 1000).toFixed(1)}s</span>
      </div>
    `
    item.addEventListener("click", () => {
      const latestRun = state.recentRuns.find((r) => r.handle === person.handle)
      if (latestRun) inspectRunById(latestRun.id)
      fetchState(person.handle, "all")
    })
    rosterList.appendChild(item)
  })
}

// Draw captured hand trajectories & click bullseye scatter
function renderLabVisuals() {
  drawCapturedPaths()
  drawVelocityProfile()
}

function drawCapturedPaths() {
  const dpr = window.devicePixelRatio || 1
  const w = pathsCanvas.clientWidth || 420
  const h = pathsCanvas.clientHeight || 220
  pathsCanvas.width = w * dpr
  pathsCanvas.height = h * dpr
  const ctx = pathsCanvas.getContext("2d")
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  traceCaption.textContent = `${inspectedRunLabel} (${inspectedReaches.length} reaches)`

  // Subtle grid
  ctx.strokeStyle = "rgba(236, 235, 227, 0.04)"
  ctx.lineWidth = 1
  for (let x = 40; x < w; x += 40) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
  for (let y = 40; y < h; y += 40) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }

  if (inspectedReaches.length === 0) return

  let maxX = 1
  let maxY = 1
  for (const r of inspectedReaches) {
    maxX = Math.max(maxX, r.from.x, r.to.x)
    maxY = Math.max(maxY, r.from.y, r.to.y)
  }
  const pad = 22
  const sx = (w - pad * 2) / Math.max(300, maxX * 1.05)
  const sy = (h - pad * 2) / Math.max(200, maxY * 1.05)

  inspectedReaches.forEach((r, reachIdx) => {
    if (!r.samples || r.samples.length < 2) return
    const analysis = inspectedReachAnalyses[reachIdx]
    const mode = analysis?.mode || "direct"
    // Straight reference chord
    ctx.strokeStyle = "rgba(236, 235, 227, 0.08)"
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(pad + r.from.x * sx, pad + r.from.y * sy)
    ctx.lineTo(pad + r.to.x * sx, pad + r.to.y * sy)
    ctx.stroke()

    // Actual hand path colored by submovement class
    ctx.strokeStyle =
      mode === "overshoot"
        ? "rgba(229, 169, 60, 0.85)"
        : mode === "undershoot"
          ? "rgba(88, 184, 156, 0.85)"
          : "rgba(240, 77, 48, 0.68)"
    ctx.lineWidth = mode === "direct" ? 1.5 : 1.9
    ctx.beginPath()
    r.samples.forEach((s, idx) => {
      const px = pad + s.x * sx
      const py = pad + s.y * sy
      if (idx === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    })
    ctx.stroke()

    // Submovement apex / re-clutch marker
    if (analysis?.submovementPoint) {
      const mx = pad + analysis.submovementPoint.x * sx
      const my = pad + analysis.submovementPoint.y * sy
      if (mode === "overshoot") {
        ctx.strokeStyle = "#e5a93c"
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(mx, my, 4.2, 0, Math.PI * 2)
        ctx.stroke()
      } else if (mode === "undershoot") {
        ctx.fillStyle = "#58b89c"
        ctx.beginPath()
        ctx.moveTo(mx, my - 4.2)
        ctx.lineTo(mx + 4.2, my)
        ctx.lineTo(mx, my + 4.2)
        ctx.lineTo(mx - 4.2, my)
        ctx.closePath()
        ctx.fill()
      }
    }

    // Landing point dot
    ctx.fillStyle = "#ecebe3"
    ctx.beginPath()
    ctx.arc(pad + r.to.x * sx, pad + r.to.y * sy, 2.2, 0, Math.PI * 2)
    ctx.fill()
  })

  // Bullseye inset in bottom-right showing click landing offsets relative to compact target centers
  const br = 30
  const bx = w - br - 14
  const by = h - br - 14
  ctx.fillStyle = "rgba(18, 19, 16, 0.88)"
  ctx.strokeStyle = "rgba(236, 235, 227, 0.2)"
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(bx, by, br, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(bx, by, br * 0.5, 0, Math.PI * 2)
  ctx.strokeStyle = "rgba(236, 235, 227, 0.1)"
  ctx.stroke()

  for (const r of inspectedReaches) {
    if ((r.targetWidth || 40) > 96) continue
    const dx = clamp((r.to.x - r.targetCenter.x) * 3.2, -br + 3, br - 3)
    const dy = clamp((r.to.y - r.targetCenter.y) * 3.2, -br + 3, br - 3)
    ctx.fillStyle = "#f04d30"
    ctx.beginPath()
    ctx.arc(bx + dx, by + dy, 2, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawVelocityProfile() {
  const dpr = window.devicePixelRatio || 1
  const w = velocityCanvas.clientWidth || 420
  const h = velocityCanvas.clientHeight || 140
  velocityCanvas.width = w * dpr
  velocityCanvas.height = h * dpr
  const ctx = velocityCanvas.getContext("2d")
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const model = serverState?.model
  const subchartTag = document.querySelector("#subchart-tag")
  if (activeSubchart === "scroll-keys") {
    if (subchartTag) {
      subchartTag.innerHTML = `Scroll curve (left) · Keystroke IKI &amp; hold (right)`
    }
    const padT = 26
    const padB = 16
    const plotH = h - padT - padB
    const leftW = Math.floor(w * 0.46) - 20
    const scrollBins = model?.scrollCurve || [0.38, 0.92, 1.48, 1.82, 1.74, 1.46, 1.16, 0.88, 0.64, 0.44, 0.28, 0.14]
    const maxS = Math.max(2.0, ...scrollBins)
    const sBarW = leftW / scrollBins.length
    ctx.fillStyle = "rgba(88, 184, 156, 0.28)"
    scrollBins.forEach((v, idx) => {
      const bh = (v / maxS) * plotH
      ctx.fillRect(14 + idx * sBarW + 1, padT + plotH - bh, Math.max(2, sBarW - 2), bh)
    })
    ctx.strokeStyle = "#58b89c"
    ctx.lineWidth = 1.8
    ctx.beginPath()
    scrollBins.forEach((v, idx) => {
      const x = 14 + (idx + 0.5) * sBarW
      const y = padT + plotH - (v / maxS) * plotH
      if (idx === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()

    // Right half: keystroke IKI (orange) + holdMs (teal)
    const keys = (inspectedKeys.length > 0 ? inspectedKeys : [{ ikiMs: 85, holdMs: 68 }, { ikiMs: 74, holdMs: 62 }, { ikiMs: 92, holdMs: 71 }, { ikiMs: 68, holdMs: 58 }, { ikiMs: 110, holdMs: 80 }]).slice(0, 18)
    const rightX = Math.floor(w * 0.52)
    const rightW = w - rightX - 14
    const kSlotW = rightW / Math.max(1, keys.length)
    const maxK = Math.max(220, ...keys.map((k) => k.ikiMs || 0))
    keys.forEach((k, idx) => {
      const x = rightX + idx * kSlotW
      const ikiH = (clamp(k.ikiMs || 80, 10, maxK) / maxK) * plotH
      const holdH = (clamp(k.holdMs || 65, 10, maxK) / maxK) * plotH
      ctx.fillStyle = "rgba(240, 77, 48, 0.65)"
      ctx.fillRect(x + 1, padT + plotH - ikiH, Math.max(2, kSlotW * 0.44), ikiH)
      ctx.fillStyle = "rgba(88, 184, 156, 0.75)"
      ctx.fillRect(x + 1 + Math.max(2, kSlotW * 0.46), padT + plotH - holdH, Math.max(2, kSlotW * 0.42), holdH)
    })
    return
  }

  if (subchartTag) {
    subchartTag.innerHTML = `Normalized speed v(u) · peak u = <strong id="peak-u-label">${model?.reach?.peakVelocityU ?? 0.39}</strong>`
  }
  const bins = model?.velocityCurve || [
    0.12, 0.44, 0.88, 1.32, 1.68, 1.89, 1.94, 1.84, 1.64, 1.4,
    1.16, 0.94, 0.74, 0.57, 0.42, 0.3, 0.21, 0.14, 0.08, 0.03,
  ]
  const padL = 16
  const padR = 16
  const padT = 26
  const padB = 18
  const plotW = w - padL - padR
  const plotH = h - padT - padB
  const maxV = Math.max(2.2, ...bins)

  // Symmetric minimum-jerk reference curve (peaks at u = 0.50)
  ctx.strokeStyle = "rgba(236, 235, 227, 0.22)"
  ctx.setLineDash([4, 4])
  ctx.lineWidth = 1.2
  ctx.beginPath()
  for (let i = 0; i <= 60; i++) {
    const u = i / 60
    const v = 30 * u * u * (1 - u) * (1 - u)
    const x = padL + u * plotW
    const y = padT + plotH - (v / maxV) * plotH
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.setLineDash([])

  // Empirical 20-bin bars
  const barW = plotW / bins.length
  ctx.fillStyle = "rgba(240, 77, 48, 0.2)"
  bins.forEach((v, idx) => {
    const bh = (v / maxV) * plotH
    ctx.fillRect(padL + idx * barW + 1, padT + plotH - bh, Math.max(2, barW - 2), bh)
  })

  // Fitted asymmetric Woodworth-Meyer curve
  const gamma = model?.reach?.ballisticExponent ?? 0.74
  ctx.strokeStyle = "#f04d30"
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let i = 0; i <= 80; i++) {
    const u = Math.max(0.001, i / 80)
    const s = Math.pow(u, gamma)
    const dsdu = gamma * Math.pow(u, gamma - 1)
    const djds = 30 * s * s * (1 - s) * (1 - s)
    const v = djds * dsdu
    const x = padL + u * plotW
    const y = padT + plotH - (v / maxV) * plotH
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

// 3-Cursor Live Comparator (Playwright teleport vs Baseline v1 vs Fitted Model)
let compFrom = { x: 70, y: 180 }
let compTo = { x: 320, y: 90 }
let compRaceStartedAt = performance.now()
let compPaths = null

function minimumJerk(t) {
  const u = clamp(t, 0, 1)
  return u * u * u * (10 - 15 * u + 6 * u * u)
}

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

function synthesizePath(from, rawTo, profile) {
  const p = profile || serverState?.baseline
  const aimDx = clamp((p?.click?.aimBiasX ?? 0) + (Math.random() - 0.5) * 2.2, -3, 3)
  const aimDy = clamp((p?.click?.aimBiasY ?? 0) + (Math.random() - 0.5) * 1.8, -2.5, 2.5)
  const to = { x: rawTo.x + aimDx, y: rawTo.y + aimDy }
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.max(4, Math.hypot(dx, dy))
  const tx = dx / dist
  const ty = dy / dist
  const nx = -ty
  const ny = tx

  const baseMs = p?.reach?.baseMs ?? 110
  const sqrtScale = p?.reach?.sqrtScale ?? 5.4
  const durationMs = clamp(baseMs + Math.sqrt(dist) * sqrtScale, 110, 290)
  const gamma = p?.reach?.ballisticExponent ?? 0.74
  const wristBias = -tx * (p?.reach?.wristBias ?? 0.045) * dist
  const bowRatio = ((p?.reach?.bowMinRatio ?? 0.04) + (p?.reach?.bowMaxRatio ?? 0.12)) * 0.5
  const bow = (Math.random() < 0.5 ? -1 : 1) * bowRatio * dist + wristBias

  const overRate = p?.submovements?.overshootRate ?? 0.28
  const underRate = p?.submovements?.undershootRate ?? 0.22
  const roll = dist > 120 ? Math.random() : 1
  const mode = roll < overRate ? "overshoot" : roll < overRate + underRate ? "undershoot" : "direct"
  const split = mode === "overshoot" ? 0.8 : mode === "undershoot" ? 0.74 : 1
  const primaryEnd =
    mode === "overshoot"
      ? { x: to.x + tx * 6.5, y: to.y + ty * 6.5 }
      : mode === "undershoot"
        ? { x: to.x - tx * 11, y: to.y - ty * 11 }
        : to

  const c1 = { x: from.x + (primaryEnd.x - from.x) * 0.28 + nx * bow, y: from.y + (primaryEnd.y - from.y) * 0.28 + ny * bow }
  const c2 = { x: from.x + (primaryEnd.x - from.x) * 0.71 + nx * bow * 0.52, y: from.y + (primaryEnd.y - from.y) * 0.71 + ny * bow * 0.52 }

  const samples = []
  for (let i = 0; i <= 40; i++) {
    const u = i / 40
    let base
    if (u <= split) {
      const s = minimumJerk(Math.pow(u / split, gamma))
      base = bezier(from, c1, c2, primaryEnd, s)
    } else {
      const s = minimumJerk((u - split) / (1 - split))
      base = { x: primaryEnd.x + (to.x - primaryEnd.x) * s, y: primaryEnd.y + (to.y - primaryEnd.y) * s }
    }
    const env = Math.sin(Math.PI * u) * Math.pow(1 - u, 0.45)
    const wave = Math.sin(u * Math.PI * 4.2) * 1.3 * env
    samples.push({
      u,
      x: u >= 0.999 ? to.x : base.x + nx * wave,
      y: u >= 0.999 ? to.y : base.y + ny * wave,
    })
  }
  return { durationMs, samples, to }
}

function triggerComparatorRace(targetPt) {
  compFrom = compTo
  compTo = targetPt
  compRaceStartedAt = performance.now()
  compPaths = {
    base: synthesizePath(compFrom, compTo, serverState?.baseline),
    fitted: synthesizePath(compFrom, compTo, serverState?.model || serverState?.baseline),
  }
}

comparatorBox.addEventListener("pointerdown", (e) => {
  const rect = comparatorBox.getBoundingClientRect()
  triggerComparatorRace({
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  })
})

function drawDartCursor(ctx, x, y, color, label, labelOffset = { dx: 14, dy: 12 }) {
  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = color
  ctx.strokeStyle = "#121310"
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(13, 5.2)
  ctx.lineTo(7.4, 7.4)
  ctx.lineTo(5.2, 13)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  if (label) {
    ctx.font = "500 10px InterVariable, sans-serif"
    ctx.fillStyle = color
    ctx.fillText(label, labelOffset.dx, labelOffset.dy)
  }
  ctx.restore()
}

function renderComparatorLoop() {
  if (viewLab.classList.contains("active")) {
    const dpr = window.devicePixelRatio || 1
    const w = comparatorCanvas.clientWidth || 420
    const h = comparatorCanvas.clientHeight || 340
    if (comparatorCanvas.width !== w * dpr || comparatorCanvas.height !== h * dpr) {
      comparatorCanvas.width = w * dpr
      comparatorCanvas.height = h * dpr
    }
    const ctx = comparatorCanvas.getContext("2d")
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const now = performance.now()
    if (!compPaths || (autoRaceToggle.checked && now - compRaceStartedAt > 1250)) {
      const margin = 48
      triggerComparatorRace({
        x: Math.round(margin + Math.random() * Math.max(80, w - margin * 2)),
        y: Math.round(margin + Math.random() * Math.max(80, h - margin * 2 - 28)),
      })
    }

    const elapsed = now - compRaceStartedAt

    // Target ring
    ctx.strokeStyle = "rgba(236, 235, 227, 0.25)"
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.arc(compTo.x, compTo.y, 14, 0, Math.PI * 2)
    ctx.stroke()

    for (const [key, color] of [
      ["base", "#e5a93c"],
      ["fitted", "#f04d30"],
    ]) {
      const path = compPaths[key]
      if (!path) continue
      ctx.strokeStyle = key === "fitted" ? "rgba(240, 77, 48, 0.45)" : "rgba(229, 169, 60, 0.3)"
      ctx.lineWidth = key === "fitted" ? 1.8 : 1.2
      ctx.beginPath()
      path.samples.forEach((pt, idx) => {
        if (idx === 0) ctx.moveTo(pt.x, pt.y)
        else ctx.lineTo(pt.x, pt.y)
      })
      ctx.stroke()
    }

    // 1. Raw Playwright (teleports at t=0ms)
    drawDartCursor(ctx, compTo.x, compTo.y, "#767870", "raw (0ms)", { dx: -54, dy: -6 })

    // 2. Baseline v1
    const uBase = clamp(elapsed / compPaths.base.durationMs, 0, 1)
    const baseIdx = Math.min(compPaths.base.samples.length - 1, Math.floor(uBase * (compPaths.base.samples.length - 1)))
    const basePt = compPaths.base.samples[baseIdx]
    drawDartCursor(ctx, basePt.x, basePt.y, "#e5a93c", `v1 (${Math.round(compPaths.base.durationMs)}ms)`, { dx: 15, dy: 4 })

    // 3. Fitted Model
    const uFit = clamp(elapsed / compPaths.fitted.durationMs, 0, 1)
    const fitIdx = Math.min(compPaths.fitted.samples.length - 1, Math.floor(uFit * (compPaths.fitted.samples.length - 1)))
    const fitPt = compPaths.fitted.samples[fitIdx]
    drawDartCursor(ctx, fitPt.x, fitPt.y, "#f04d30", `fitted (${Math.round(compPaths.fitted.durationMs)}ms)`, { dx: 15, dy: 18 })
  }
  requestAnimationFrame(renderComparatorLoop)
}
requestAnimationFrame(renderComparatorLoop)

// Copy buttons
copyJsonBtn.addEventListener("click", async () => {
  const profile = serverState?.model
  if (!profile) return
  await navigator.clipboard.writeText(JSON.stringify(profile, null, 2))
  copyJsonBtn.textContent = "Copied JSON"
  setTimeout(() => (copyJsonBtn.textContent = "Copy JSON"), 1400)
})

copyCliBtn.addEventListener("click", async () => {
  const query = selectedHandleFilter !== "all" ? `?handle=${encodeURIComponent(selectedHandleFilter)}` : ""
  const cmd = `mkdir -p ~/.browser-control && curl -fsSL "${location.origin}/api/model${query}" | jq .profile > ~/.browser-control/human-model.json`
  await navigator.clipboard.writeText(cmd)
  copyCliBtn.textContent = "Copied CLI"
  setTimeout(() => (copyCliBtn.textContent = "Copy CLI sync"), 1400)
})

// Live WebSocket connection
function connectLiveSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:"
  const ws = new WebSocket(`${proto}//${location.host}/api/live`)
  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data)
      if (msg.type === "viewers" && typeof msg.activeViewers === "number") {
        liveCountEl.textContent = `${Math.max(1, msg.activeViewers)} online`
      } else if (msg.type === "state" && msg.state) {
        if (selectedHandleFilter === "all") {
          applyServerState(msg.state)
        } else {
          fetchState(selectedHandleFilter)
        }
      }
    } catch {
      // ignore malformed messages
    }
  })
  ws.addEventListener("close", () => {
    setTimeout(connectLiveSocket, 2500)
  })
}

window.addEventListener("resize", () => {
  if (viewLab.classList.contains("active")) renderLabVisuals()
})

// Initialize
resetCourse()
fetchState("all")
connectLiveSocket()
