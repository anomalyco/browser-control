// Minimal, single-capsule GPU Dynamic Island for Browser Control.
// Compact state: a quiet 48x26px carbon pill with three breathing warm-ivory dots (no text, no second circle).
// Expanded state: smoothly unfolds into a 324x82px permission / handoff card.
// Both expansion and collapse drive inner content opacity/scale as a continuous function of live spring progress `u`,
// so DOM nodes are never abruptly removed mid-transition.

class Spring {
  v = 0
  target: number
  constructor(
    public x: number,
    public omega = 20,
    public zeta = 0.88,
  ) {
    this.target = x
  }
  set(target: number): this {
    this.target = target
    return this
  }
  snap(x: number): this {
    this.x = this.target = x
    this.v = 0
    return this
  }
  step(dt: number): number {
    if (this.x === this.target && this.v === 0) return this.x
    const h = 1 / 480
    for (let t = 0; t < dt; t += h) {
      const k = Math.min(h, dt - t)
      const a = -this.omega * this.omega * (this.x - this.target) - 2 * this.zeta * this.omega * this.v
      this.v += a * k
      this.x += this.v * k
    }
    if (Math.abs(this.x - this.target) < 0.01 && Math.abs(this.v) < 0.01) {
      this.x = this.target
      this.v = 0
    }
    return this.x
  }
  get resting(): boolean {
    return Math.abs(this.x - this.target) < 0.02 && Math.abs(this.v) < 0.08
  }
}

export const ISLAND_CANVAS_W = 420
export const ISLAND_CANVAS_H = 128

const COMPACT_W = 52
const COMPACT_H = 26
const EXPANDED_W = 324
const EXPANDED_H = 82

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

const WGSL_SOURCE = /* wgsl */ `
struct Uniforms {
  u0: vec4f, // canvasW, canvasH, dpr, time
  u1: vec4f, // islandW, islandH, radius, topY
  u2: vec4f, // dotsAlpha, active, pad, pad
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs_main(@builtin(vertex_index) idx: u32) -> VSOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  let c = corners[idx];
  var o: VSOut;
  o.pos = vec4f(c, 0.0, 1.0);
  o.uv = vec2f(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
  return o;
}

fn sdRoundedBox(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn shadeThreeDots(p: vec2f, center: vec2f, dpr: f32, time: f32, running: f32) -> vec4f {
  let q = p - center;
  if (abs(q.x) > 18.0 || abs(q.y) > 8.0) { return vec4f(0.0); }
  let aa = 0.55 / dpr;
  let ivory = vec3f(0.95, 0.94, 0.91);
  var totalA = 0.0;
  for (var i = 0; i < 3; i++) {
    let fi = f32(i) - 1.0;
    let dotPos = vec2f(fi * 8.0, 0.0);
    let phase = time * 3.4 - f32(i) * 0.85;
    let wave = mix(0.35, 0.5 + 0.5 * sin(phase), running);
    let r = mix(1.75, 2.35, wave);
    let lum = mix(0.32, 0.96, wave);
    let d = length(q - dotPos) - r;
    let cov = 1.0 - smoothstep(-aa, aa, d);
    totalA = max(totalA, cov * lum);
  }
  return vec4f(ivory * totalA, totalA);
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let p = in.uv * u.u0.xy;
  let dpr = max(u.u0.z, 1.0);
  let time = u.u0.w;
  let w = u.u1.x;
  let h = u.u1.y;
  let r = u.u1.z;
  let topY = u.u1.w;
  let dotsAlpha = clamp(u.u2.x, 0.0, 1.0);
  let running = clamp(u.u2.y, 0.0, 1.0);

  let center = vec2f(u.u0.x * 0.5, topY + h * 0.5);
  let halfSize = max(vec2f(w, h) * 0.5, vec2f(6.0));
  let rr = min(r, min(halfSize.x, halfSize.y));
  let d = sdRoundedBox(p - center, halfSize, rr);
  let cov = clamp(0.5 - d * dpr, 0.0, 1.0);
  if (cov <= 0.001) {
    return vec4f(0.0);
  }

  let ivory = vec3f(0.95, 0.94, 0.91);
  let hairMask = clamp(1.0 - abs(d * dpr + 0.75), 0.0, 1.0);
  var rgb = vec3f(0.039, 0.039, 0.045) + ivory * hairMask * 0.14;

  if (dotsAlpha > 0.005) {
    let dots = shadeThreeDots(p, center, dpr, time, running) * dotsAlpha;
    rgb = rgb * (1.0 - dots.a) + dots.rgb;
  }

  return vec4f(min(rgb, vec3f(1.0)) * cov, cov);
}
`

const GLSL_VS = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
}
`

const GLSL_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform vec4 u0; // canvasW, canvasH, dpr, time
uniform vec4 u1; // islandW, islandH, radius, topY
uniform vec4 u2; // dotsAlpha, running, pad, pad

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

vec4 shadeThreeDots(vec2 p, vec2 center, float dpr, float time, float running) {
  vec2 q = p - center;
  if (abs(q.x) > 18.0 || abs(q.y) > 8.0) return vec4(0.0);
  float aa = 0.55 / dpr;
  vec3 ivory = vec3(0.95, 0.94, 0.91);
  float totalA = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i) - 1.0;
    vec2 dotPos = vec2(fi * 8.0, 0.0);
    float phase = time * 3.4 - float(i) * 0.85;
    float wave = mix(0.35, 0.5 + 0.5 * sin(phase), running);
    float r = mix(1.75, 2.35, wave);
    float lum = mix(0.32, 0.96, wave);
    float d = length(q - dotPos) - r;
    float cov = 1.0 - smoothstep(-aa, aa, d);
    totalA = max(totalA, cov * lum);
  }
  return vec4(ivory * totalA, totalA);
}

void main() {
  vec2 p = v_uv * u0.xy;
  float dpr = max(u0.z, 1.0);
  float time = u0.w;
  float w = u1.x, h = u1.y, r = u1.z, topY = u1.w;
  float dotsAlpha = clamp(u2.x, 0.0, 1.0);
  float running = clamp(u2.y, 0.0, 1.0);

  vec2 center = vec2(u0.x * 0.5, topY + h * 0.5);
  vec2 halfSize = max(vec2(w, h) * 0.5, vec2(6.0));
  float rr = min(r, min(halfSize.x, halfSize.y));
  float d = sdRoundedBox(p - center, halfSize, rr);
  float cov = clamp(0.5 - d * dpr, 0.0, 1.0);
  if (cov <= 0.001) {
    fragColor = vec4(0.0);
    return;
  }

  vec3 ivory = vec3(0.95, 0.94, 0.91);
  float hairMask = clamp(1.0 - abs(d * dpr + 0.75), 0.0, 1.0);
  vec3 rgb = vec3(0.039, 0.039, 0.045) + ivory * hairMask * 0.14;

  if (dotsAlpha > 0.005) {
    vec4 dots = shadeThreeDots(p, center, dpr, time, running) * dotsAlpha;
    rgb = rgb * (1.0 - dots.a) + dots.rgb;
  }

  fragColor = vec4(min(rgb, vec3(1.0)) * cov, cov);
}
`

type GpuBackend = {
  readonly draw: (uniforms: Float32Array) => void
}

async function initWebGpuBackend(canvas: HTMLCanvasElement): Promise<GpuBackend | null> {
  const gpu = (navigator as Navigator & { readonly gpu?: any }).gpu
  if (!gpu) return null
  try {
    const adapter = await gpu.requestAdapter()
    if (!adapter) return null
    const device = await adapter.requestDevice()
    const context = canvas.getContext("webgpu") as any
    if (!context) return null
    const format = gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: "premultiplied" })
    const module = device.createShaderModule({ code: WGSL_SOURCE })
    const uniformBuffer = device.createBuffer({
      size: 48,
      usage: 0x0040 | 0x0008,
    })
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 0x1 | 0x2, buffer: { type: "uniform" } }],
    })
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{
          format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    })
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    })
    return {
      draw(uniforms: Float32Array) {
        device.queue.writeBuffer(uniformBuffer, 0, uniforms.buffer, uniforms.byteOffset, 48)
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          }],
        })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bindGroup)
        pass.draw(6)
        pass.end()
        device.queue.submit([encoder.finish()])
      },
    }
  } catch {
    return null
  }
}

function initWebGl2Backend(canvas: HTMLCanvasElement): GpuBackend | null {
  try {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false })
    if (!gl) return null
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)
      if (!sh) return null
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null
      return sh
    }
    const vs = compile(gl.VERTEX_SHADER, GLSL_VS)
    const fs = compile(gl.FRAGMENT_SHADER, GLSL_FS)
    if (!vs || !fs) return null
    const prog = gl.createProgram()
    if (!prog) return null
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    const u0Loc = gl.getUniformLocation(prog, "u0")
    const u1Loc = gl.getUniformLocation(prog, "u1")
    const u2Loc = gl.getUniformLocation(prog, "u2")
    return {
      draw(uniforms: Float32Array) {
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.useProgram(prog)
        gl.uniform4fv(u0Loc, uniforms.subarray(0, 4))
        gl.uniform4fv(u1Loc, uniforms.subarray(4, 8))
        gl.uniform4fv(u2Loc, uniforms.subarray(8, 12))
        gl.drawArrays(gl.TRIANGLES, 0, 6)
      },
    }
  } catch {
    return null
  }
}

export class DynamicIslandRig {
  // Asymmetric critically-damped springs: width slightly leads height for a natural pillowy unfold
  readonly w = new Spring(COMPACT_W, 20, 0.88)
  readonly h = new Spring(COMPACT_H, 18, 0.86)
  readonly r = new Spring(13, 22, 0.90)
  readonly topY = new Spring(8, 22, 0.90)
  toneMode = 0
  private backend: GpuBackend | null = null
  private initializing = false
  private rafId = 0
  private lastTime = 0
  private simTime = 0
  private virtualMode = false
  private readonly uniforms = new Float32Array(12)

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly contentEl: HTMLElement,
  ) {
    this.syncCanvasResolution()
    void this.ensureBackend()
  }

  private syncCanvasResolution(): number {
    const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1))
    const pw = Math.round(ISLAND_CANVAS_W * dpr)
    const ph = Math.round(ISLAND_CANVAS_H * dpr)
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw
      this.canvas.height = ph
    }
    return dpr
  }

  private async ensureBackend(): Promise<void> {
    if (this.backend || this.initializing) return
    this.initializing = true
    this.backend = (await initWebGpuBackend(this.canvas)) ?? initWebGl2Backend(this.canvas)
    this.initializing = false
    this.startLoop()
  }

  configure(options: {
    readonly tone: "active" | "running" | "waiting"
    readonly isTabRequest: boolean
    readonly label?: string
    readonly message?: string
  }): void {
    if (options.tone === "waiting") {
      this.w.set(EXPANDED_W)
      this.h.set(EXPANDED_H)
      this.r.set(20)
      this.topY.set(10)
      this.toneMode = options.isTabRequest ? 3 : 2
    } else if (options.tone === "running") {
      this.w.set(COMPACT_W)
      this.h.set(COMPACT_H)
      this.r.set(13)
      this.topY.set(8)
      this.toneMode = 1
    } else {
      this.w.set(COMPACT_W)
      this.h.set(COMPACT_H)
      this.r.set(13)
      this.topY.set(8)
      this.toneMode = 0
    }
    this.startLoop()
  }

  stepFrame(dt: number): void {
    this.simTime += dt
    const w = this.w.step(dt)
    const h = this.h.step(dt)
    const r = this.r.step(dt)
    const topY = this.topY.step(dt)

    // Continuous expansion ratio u in [0, 1] drives both the 3-dot dissolve and the permission card reveal
    const u = Math.max(0, Math.min(1, (w - COMPACT_W) / (EXPANDED_W - COMPACT_W)))
    const dotsAlpha = 1 - smoothstep(0.0, 0.34, u)
    const cardAlpha = smoothstep(0.38, 0.94, u)
    const cardScale = 0.92 + 0.08 * cardAlpha
    const cardShiftY = (1 - cardAlpha) * -4

    // Keep contentEl at the fixed expanded layout size so text never reflows during morphs
    this.contentEl.style.width = `${EXPANDED_W}px`
    this.contentEl.style.height = `${EXPANDED_H}px`
    this.contentEl.style.left = `${(ISLAND_CANVAS_W * 0.5 - EXPANDED_W * 0.5).toFixed(1)}px`
    this.contentEl.style.top = `${topY.toFixed(1)}px`
    this.contentEl.style.opacity = cardAlpha.toFixed(3)
    this.contentEl.style.transformOrigin = "50% 0%"
    this.contentEl.style.transform = `translate3d(0, ${cardShiftY.toFixed(2)}px, 0) scale(${cardScale.toFixed(3)})`
    this.contentEl.style.pointerEvents = cardAlpha > 0.8 ? "auto" : "none"

    if (this.backend) {
      const dpr = this.syncCanvasResolution()
      const buf = this.uniforms
      buf[0] = ISLAND_CANVAS_W
      buf[1] = ISLAND_CANVAS_H
      buf[2] = dpr
      buf[3] = this.simTime
      buf[4] = w
      buf[5] = h
      buf[6] = r
      buf[7] = topY
      buf[8] = dotsAlpha
      buf[9] = this.toneMode >= 1 ? 1 : 0
      buf[10] = 0
      buf[11] = 0
      this.backend.draw(buf)
    }
  }

  enableVirtualClock(): void {
    this.virtualMode = true
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
  }

  startLoop(): void {
    if (this.virtualMode || this.rafId) return
    this.lastTime = performance.now()
    const tick = (now: number) => {
      this.rafId = 0
      const dt = Math.min(0.05, Math.max(1 / 240, (now - this.lastTime) / 1000))
      this.lastTime = now
      this.stepFrame(dt)
      const animating =
        this.toneMode === 1 ||
        !this.w.resting ||
        !this.h.resting
      if (animating && this.canvas.isConnected) {
        this.rafId = window.requestAnimationFrame(tick)
      }
    }
    this.rafId = window.requestAnimationFrame(tick)
  }

  destroy(): void {
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
  }
}
