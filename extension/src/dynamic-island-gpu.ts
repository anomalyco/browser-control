// Minimal GPU Dynamic Island for Browser Control.
// Idle: a small carbon pill carrying the Browser Control arrow mark.
// Working: the pill widens slightly and the mark gives way to three breathing ivory dots.
// Expanded: the same shape unfolds into the permission / handoff card.
// Every property is an interruptible spring parameterised like Motion (visualDuration + bounce),
// so retargeting mid-flight keeps velocity instead of restarting.

type SpringTransition = {
  readonly visualDuration: number
  readonly bounce?: number
  readonly delay?: number
}

const reducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false

// Motion's mapping: visualDuration is the time to first reach the target, bounce trades damping for overshoot.
function springConstants(transition: SpringTransition): { readonly omega: number; readonly zeta: number } {
  const omega = (2 * Math.PI) / (transition.visualDuration * 1.2)
  return { omega, zeta: Math.min(1, Math.max(0.05, 1 - (transition.bounce ?? 0))) }
}

class Spring {
  v = 0
  target: number
  private omega = 20
  private zeta = 1
  private delay = 0

  constructor(
    public x: number,
    private readonly precision = 0.02,
  ) {
    this.target = x
  }

  to(target: number, transition: SpringTransition): this {
    if (reducedMotion()) return this.snap(target)
    const { omega, zeta } = springConstants(transition)
    this.omega = omega
    this.zeta = zeta
    this.delay = transition.delay ?? 0
    this.target = target
    return this
  }

  snap(x: number): this {
    this.x = this.target = x
    this.v = 0
    this.delay = 0
    return this
  }

  step(dt: number): number {
    if (this.delay > 0) {
      const wait = Math.min(this.delay, dt)
      this.delay -= wait
      dt -= wait
    }
    if (dt <= 0 || (this.x === this.target && this.v === 0)) return this.x
    const h = 1 / 480
    for (let t = 0; t < dt; t += h) {
      const k = Math.min(h, dt - t)
      const a = -this.omega * this.omega * (this.x - this.target) - 2 * this.zeta * this.omega * this.v
      this.v += a * k
      this.x += this.v * k
    }
    if (this.resting) this.snap(this.target)
    return this.x
  }

  get resting(): boolean {
    return this.delay <= 0 && Math.abs(this.x - this.target) < this.precision && Math.abs(this.v) < this.precision * 10
  }
}

// Samples a critically/under-damped spring into a CSS linear() easing, the same trick Motion uses for CSS springs.
export function springCss(transition: SpringTransition): string {
  const { omega, zeta } = springConstants(transition)
  const h = 1 / 480
  const points = [0]
  let x = 0
  let v = 0
  let elapsed = 0
  while (elapsed < 2 && (Math.abs(1 - x) > 0.0005 || Math.abs(v) > 0.005)) {
    for (let i = 0; i < 8; i++) {
      v += (-omega * omega * (x - 1) - 2 * zeta * omega * v) * h
      x += v * h
    }
    elapsed += 8 * h
    points.push(x)
  }
  points[points.length - 1] = 1
  const stride = Math.max(1, Math.round(points.length / 40))
  const sampled = points.filter((_, index) => index % stride === 0 || index === points.length - 1)
  return `${Math.round(elapsed * 1000)}ms linear(${sampled.map((value) => value.toFixed(4)).join(", ")})`
}

export const ISLAND_CANVAS_W = 420
export const ISLAND_CANVAS_H = 128

const COMPACT_W = 52
const IDLE_W = 38
const COMPACT_H = 26
const COMPACT_R = 13
const EXPANDED_W = 324
const EXPANDED_H = 82
const EXPANDED_R = 22
const TOP_Y = 8

const WGSL_SOURCE = /* wgsl */ `
struct Uniforms {
  u0: vec4f, // canvasW, canvasH, dpr, time
  u1: vec4f, // islandW, islandH, radius, topY
  u2: vec4f, // dotsAlpha, tint, presence, dotScale
  u3: vec4f, // rimTint, rimWidth, pad, pad
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

fn shadeThreeDots(p: vec2f, center: vec2f, dpr: f32, time: f32, scale: f32) -> vec4f {
  let q = (p - center) / max(scale, 0.05);
  if (abs(q.x) > 18.0 || abs(q.y) > 8.0) { return vec4f(0.0); }
  let aa = 0.55 / (dpr * max(scale, 0.05));
  let ivory = vec3f(0.95, 0.94, 0.91);
  var totalA = 0.0;
  for (var i = 0; i < 3; i++) {
    let fi = f32(i) - 1.0;
    let dotPos = vec2f(fi * 8.0, 0.0);
    let phase = time * 3.4 - f32(i) * 0.85;
    let wave = 0.5 + 0.5 * sin(phase);
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
  let presence = clamp(u.u2.z, 0.0, 1.0);
  let dotScale = u.u2.w;

  let center = vec2f(u.u0.x * 0.5, topY + h * 0.5);
  let halfSize = max(vec2f(w, h) * 0.5, vec2f(6.0));
  let rr = min(r, min(halfSize.x, halfSize.y));
  let d = sdRoundedBox(p - center, halfSize, rr);
  let cov = clamp(0.5 - d * dpr, 0.0, 1.0);
  let fall = 1.0 - smoothstep(-4.0, 14.0, sdRoundedBox(p - center - vec2f(0.0, 3.0), halfSize, rr));
  let shadow = 0.14 * fall * fall * presence;
  if (cov <= 0.001) {
    return vec4f(0.0, 0.0, 0.0, shadow);
  }

  let ivory = vec3f(0.95, 0.94, 0.91);
  let tint = mix(clamp(u.u3.x, 0.0, 1.0), clamp(u.u2.y, 0.0, 1.0), smoothstep(0.5, max(u.u3.y, 0.6), -d));
  let e = vec2f(0.75, 0.0);
  let n = normalize(vec2f(
    sdRoundedBox(p - center + e.xy, halfSize, rr) - sdRoundedBox(p - center - e.xy, halfSize, rr),
    sdRoundedBox(p - center + e.yx, halfSize, rr) - sdRoundedBox(p - center - e.yx, halfSize, rr),
  ) + vec2f(0.0, 1e-5));
  let top = clamp(-n.y, 0.0, 1.0);
  let bottom = clamp(n.y, 0.0, 1.0);
  let edge = clamp(1.0 - abs(d * dpr + 0.75), 0.0, 1.0);
  let hair = max(edge * 0.6, 1.0 - smoothstep(0.0, 0.9, abs(-d - 1.4)));
  let inner = 1.0 - smoothstep(0.0, 5.0, -d);
  // Static rim light from above: bright top hairline, faint bottom bounce, soft inner sheen under the top edge.
  let gleam = hair * (0.06 + 0.5 * top * top + 0.06 * bottom * bottom) + inner * 0.06 * top * top * top;
  var col = vec4f(vec3f(0.039, 0.039, 0.045) * tint, tint) + vec4f(ivory * gleam, gleam);
  col = min(col, vec4f(1.0));

  if (dotsAlpha > 0.005) {
    let dots = shadeThreeDots(p, center, dpr, time, dotScale) * dotsAlpha;
    col = col * (1.0 - dots.a) + dots;
  }

  let a = cov * presence;
  return vec4f(col.rgb * a, col.a * a + shadow * (1.0 - cov));
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
uniform vec4 u2; // dotsAlpha, tint, presence, dotScale
uniform vec4 u3; // rimTint, rimWidth, pad, pad

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

vec4 shadeThreeDots(vec2 p, vec2 center, float dpr, float time, float scale) {
  vec2 q = (p - center) / max(scale, 0.05);
  if (abs(q.x) > 18.0 || abs(q.y) > 8.0) return vec4(0.0);
  float aa = 0.55 / (dpr * max(scale, 0.05));
  vec3 ivory = vec3(0.95, 0.94, 0.91);
  float totalA = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i) - 1.0;
    vec2 dotPos = vec2(fi * 8.0, 0.0);
    float phase = time * 3.4 - float(i) * 0.85;
    float wave = 0.5 + 0.5 * sin(phase);
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
  float presence = clamp(u2.z, 0.0, 1.0);
  float dotScale = u2.w;

  vec2 center = vec2(u0.x * 0.5, topY + h * 0.5);
  vec2 halfSize = max(vec2(w, h) * 0.5, vec2(6.0));
  float rr = min(r, min(halfSize.x, halfSize.y));
  float d = sdRoundedBox(p - center, halfSize, rr);
  float cov = clamp(0.5 - d * dpr, 0.0, 1.0);
  float fall = 1.0 - smoothstep(-4.0, 14.0, sdRoundedBox(p - center - vec2(0.0, 3.0), halfSize, rr));
  float shadow = 0.14 * fall * fall * presence;
  if (cov <= 0.001) {
    fragColor = vec4(0.0, 0.0, 0.0, shadow);
    return;
  }

  vec3 ivory = vec3(0.95, 0.94, 0.91);
  float tint = mix(clamp(u3.x, 0.0, 1.0), clamp(u2.y, 0.0, 1.0), smoothstep(0.5, max(u3.y, 0.6), -d));
  vec2 e = vec2(0.75, 0.0);
  vec2 n = normalize(vec2(
    sdRoundedBox(p - center + e.xy, halfSize, rr) - sdRoundedBox(p - center - e.xy, halfSize, rr),
    sdRoundedBox(p - center + e.yx, halfSize, rr) - sdRoundedBox(p - center - e.yx, halfSize, rr)
  ) + vec2(0.0, 1e-5));
  float top = clamp(-n.y, 0.0, 1.0);
  float bottom = clamp(n.y, 0.0, 1.0);
  float edge = clamp(1.0 - abs(d * dpr + 0.75), 0.0, 1.0);
  float hair = max(edge * 0.6, 1.0 - smoothstep(0.0, 0.9, abs(-d - 1.4)));
  float inner = 1.0 - smoothstep(0.0, 5.0, -d);
  float gleam = hair * (0.06 + 0.5 * top * top + 0.06 * bottom * bottom) + inner * 0.06 * top * top * top;
  vec4 col = min(vec4(vec3(0.039, 0.039, 0.045) * tint, tint) + vec4(ivory * gleam, gleam), vec4(1.0));

  if (dotsAlpha > 0.005) {
    vec4 dots = shadeThreeDots(p, center, dpr, time, dotScale) * dotsAlpha;
    col = col * (1.0 - dots.a) + dots;
  }

  float a = cov * presence;
  fragColor = vec4(col.rgb * a, col.a * a + shadow * (1.0 - cov));
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
      size: 64,
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
        device.queue.writeBuffer(uniformBuffer, 0, uniforms.buffer, uniforms.byteOffset, 64)
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
    const u3Loc = gl.getUniformLocation(prog, "u3")
    return {
      draw(uniforms: Float32Array) {
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.useProgram(prog)
        gl.uniform4fv(u0Loc, uniforms.subarray(0, 4))
        gl.uniform4fv(u1Loc, uniforms.subarray(4, 8))
        gl.uniform4fv(u2Loc, uniforms.subarray(8, 12))
        gl.uniform4fv(u3Loc, uniforms.subarray(12, 16))
        gl.drawArrays(gl.TRIANGLES, 0, 6)
      },
    }
  } catch {
    return null
  }
}

export type IslandTone = "active" | "running" | "waiting"

const UNFOLD = {
  width: { visualDuration: 0.5, bounce: 0.2 },
  height: { visualDuration: 0.55, bounce: 0.16, delay: 0.025 },
  dots: { visualDuration: 0.14 },
  prompt: { visualDuration: 0.4, bounce: 0.12, delay: 0.12 },
  actions: { visualDuration: 0.4, bounce: 0.12, delay: 0.17 },
} satisfies Record<string, SpringTransition>

const FOLD = {
  content: { visualDuration: 0.1 },
  height: { visualDuration: 0.34, bounce: 0.1, delay: 0.04 },
  width: { visualDuration: 0.36, bounce: 0.18, delay: 0.07 },
  dots: { visualDuration: 0.3, delay: 0.2 },
} satisfies Record<string, SpringTransition>

// Swapping between the idle mark and the working dots without unfolding.
const SWAP = {
  width: { visualDuration: 0.4, bounce: 0.2 },
  out: { visualDuration: 0.14 },
  in: { visualDuration: 0.42, bounce: 0.3, delay: 0.06 },
} satisfies Record<string, SpringTransition>

const APPEAR = { visualDuration: 0.45, bounce: 0.24 } satisfies SpringTransition
const DISAPPEAR = { visualDuration: 0.26 } satisfies SpringTransition

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

export type IslandMaterial = {
  readonly tint: number
  readonly rimTint: number
  readonly rimWidth: number
  readonly frost: number
}

export class DynamicIslandRig {
  material: IslandMaterial = { tint: 1, rimTint: 0.25, rimWidth: 6, frost: 0 }
  private readonly w = new Spring(COMPACT_W)
  private readonly h = new Spring(COMPACT_H)
  private readonly presence = new Spring(0, 0.001)
  private readonly dots = new Spring(0, 0.001)
  private readonly mark = new Spring(0, 0.001)
  private readonly prompt = new Spring(0, 0.001)
  private readonly actions = new Spring(0, 0.001)
  private readonly markEl: SVGSVGElement
  private readonly lens: GlassLens
  private tone: IslandTone | undefined
  private visible = false
  private exitResolve: (() => void) | undefined
  private backend: GpuBackend | null = null
  private initializing = false
  private rafId = 0
  private lastTime = 0
  private simTime = 0
  private virtualMode = false
  private readonly uniforms = new Float32Array(16)

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly contentEl: HTMLElement,
  ) {
    contentEl.style.width = `${EXPANDED_W}px`
    contentEl.style.height = `${EXPANDED_H}px`
    contentEl.style.left = `${(ISLAND_CANVAS_W - EXPANDED_W) / 2}px`
    contentEl.style.top = `${TOP_Y}px`
    this.markEl = createMark()
    canvas.after(this.markEl)
    this.lens = new GlassLens(canvas)
    this.syncCanvasResolution()
    this.setVisible(true)
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

  configure(tone: IslandTone): void {
    this.setVisible(true)
    if (tone !== this.tone) {
      this.transition(this.tone, tone)
      this.tone = tone
    }
    // Apply current reveal styles to freshly rendered content even when every spring is at rest.
    this.stepFrame(0)
    this.startLoop()
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    this.presence.to(visible ? 1 : 0, visible ? APPEAR : DISAPPEAR)
    this.startLoop()
  }

  // Folds the content away and shrinks the island out; resolves once it is fully transparent.
  exit(): Promise<void> {
    this.prompt.to(0, FOLD.content)
    this.actions.to(0, FOLD.content)
    this.setVisible(false)
    return new Promise((resolve) => {
      this.exitResolve = resolve
      this.startLoop()
    })
  }

  private transition(from: IslandTone | undefined, to: IslandTone): void {
    if (to === "waiting") {
      this.w.to(EXPANDED_W, UNFOLD.width)
      this.h.to(EXPANDED_H, UNFOLD.height)
      this.dots.to(0, UNFOLD.dots)
      this.mark.to(0, UNFOLD.dots)
      this.prompt.to(1, UNFOLD.prompt)
      this.actions.to(1, UNFOLD.actions)
      return
    }
    const width = to === "running" ? COMPACT_W : IDLE_W
    const showDots = to === "running" ? 1 : 0
    if (from === undefined) {
      this.w.snap(width)
      this.dots.snap(showDots)
      this.mark.snap(1 - showDots)
      return
    }
    if (from === "waiting") {
      this.prompt.to(0, FOLD.content)
      this.actions.to(0, FOLD.content)
      this.h.to(COMPACT_H, FOLD.height)
      this.w.to(width, FOLD.width)
    } else {
      this.w.to(width, SWAP.width)
    }
    const enter = from === "waiting" ? FOLD.dots : SWAP.in
    this.dots.to(showDots, showDots ? enter : SWAP.out)
    this.mark.to(1 - showDots, showDots ? SWAP.out : { ...SWAP.in, delay: enter.delay })
  }

  private get animating(): boolean {
    const springs = [this.w, this.h, this.presence, this.dots, this.mark, this.prompt, this.actions]
    return springs.some((spring) => !spring.resting) || (this.dots.x > 0.001 && this.presence.x > 0.001)
  }

  stepFrame(dt: number): void {
    this.simTime += dt
    const presence = this.presence.step(dt)
    const dots = this.dots.step(dt)
    const mark = this.mark.step(dt)
    const prompt = this.prompt.step(dt)
    const actions = this.actions.step(dt)
    const scale = 0.45 + 0.55 * presence
    const w = this.w.step(dt) * scale
    const h = this.h.step(dt) * scale
    const unfold = clamp01((this.h.x - COMPACT_H) / (EXPANDED_H - COMPACT_H))
    const room = smoothstep(0.45, 0.9, Math.min(unfold, clamp01((this.w.x - COMPACT_W) / (EXPANDED_W - COMPACT_W))))
    const r = (COMPACT_R + (EXPANDED_R - COMPACT_R) * unfold) * scale

    // Clip the fixed-layout card to the live island shape so text is masked by the surface instead of reflowing.
    const side = (EXPANDED_W - w) / 2
    const bottom = EXPANDED_H - h
    this.contentEl.style.clipPath = `inset(0 ${side.toFixed(2)}px ${bottom.toFixed(2)}px ${side.toFixed(2)}px round ${r.toFixed(2)}px)`
    this.contentEl.style.opacity = presence > 0.001 ? "1" : "0"
    this.contentEl.style.pointerEvents = this.tone === "waiting" && actions > 0.6 ? "auto" : "none"
    this.markEl.style.top = `${(TOP_Y + h / 2).toFixed(2)}px`
    this.markEl.style.opacity = (smoothstep(0, 0.5, mark) * smoothstep(0, 0.4, presence)).toFixed(3)
    this.markEl.style.transform = `translate(-50%, -50%) scale(${(scale * (0.4 + 0.6 * mark)).toFixed(4)}) rotate(${((1 - mark) * -16).toFixed(2)}deg)`
    reveal(this.contentEl.querySelector<HTMLElement>("#__browser_control_prompt__"), prompt, room, 6)
    reveal(this.contentEl.querySelector<HTMLElement>("#__browser_control_actions__"), actions, room, 8)

    this.lens.update(w, h, r, smoothstep(0, 0.4, presence), this.material.frost)

    if (this.exitResolve && this.presence.resting && this.presence.target === 0) {
      this.exitResolve()
      this.exitResolve = undefined
    }

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
      buf[7] = TOP_Y
      buf[8] = clamp01(dots)
      // Smoky glass while compact; denser once unfolded so the prompt stays legible over any page.
      buf[9] = this.lens.active ? this.material.tint : 1
      buf[12] = this.lens.active ? this.material.rimTint : 1
      buf[13] = this.material.rimWidth
      buf[10] = smoothstep(0, 0.4, presence)
      buf[11] = scale * (0.55 + 0.45 * clamp01(dots))
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
      if (this.animating && this.canvas.isConnected) {
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
    this.exitResolve?.()
    this.exitResolve = undefined
  }
}

const SVG_NS = "http://www.w3.org/2000/svg"
const LENS_FILTER_ID = "__browser_control_lens__"

// Refracts the page beneath the island: a backdrop-filter SVG displacement whose map bends the rim inward like thick glass.
// Chromium-only (backdrop-filter: url()), and disabled when the page CSP blocks data: images or transparency is reduced.
class GlassLens {
  active = false
  private readonly element = document.createElement("div")
  private readonly filter = document.createElementNS(SVG_NS, "filter")
  private readonly map = document.createElementNS(SVG_NS, "feImage")
  private readonly displace = document.createElementNS(SVG_NS, "feDisplacementMap")
  private readonly blur = document.createElementNS(SVG_NS, "feGaussianBlur")
  private readonly scratch = document.createElement("canvas")
  private mapKey = ""

  constructor(before: Element) {
    const svg = document.createElementNS(SVG_NS, "svg")
    svg.setAttribute("aria-hidden", "true")
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;"
    this.filter.id = LENS_FILTER_ID
    const attributes = { filterUnits: "userSpaceOnUse", primitiveUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB", x: "0", y: "0" }
    for (const [name, value] of Object.entries(attributes)) this.filter.setAttribute(name, value)
    this.map.setAttribute("result", "map")
    this.map.setAttribute("preserveAspectRatio", "none")
    this.map.setAttribute("x", "0")
    this.map.setAttribute("y", "0")
    this.displace.setAttribute("in", "SourceGraphic")
    this.displace.setAttribute("in2", "map")
    this.displace.setAttribute("xChannelSelector", "R")
    this.displace.setAttribute("yChannelSelector", "G")
    const saturate = document.createElementNS(SVG_NS, "feColorMatrix")
    saturate.setAttribute("type", "saturate")
    saturate.setAttribute("values", "1.35")
    this.blur.setAttribute("edgeMode", "duplicate")
    this.filter.append(this.map, this.displace, this.blur, saturate)
    svg.append(this.filter)
    this.element.style.cssText = `position:absolute;display:none;pointer-events:none;backdrop-filter:url(#${LENS_FILTER_ID});`
    before.before(svg, this.element)

    if (window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches) return
    this.scratch.width = this.scratch.height = 1
    const probe = new Image()
    probe.onload = () => {
      this.active = true
    }
    probe.src = this.scratch.toDataURL()
  }

  update(w: number, h: number, r: number, opacity: number, frost: number): void {
    if (!this.active || opacity <= 0.001) {
      this.element.style.display = "none"
      return
    }
    const key = `${Math.round(w)}x${Math.round(h)}`
    if (key !== this.mapKey) {
      this.mapKey = key
      this.map.setAttribute("href", lensMap(this.scratch, Math.max(2, Math.round(w)), Math.max(2, Math.round(h)), r))
      this.displace.setAttribute("scale", Math.min(20, h * 0.6).toFixed(1))
    }
    this.blur.setAttribute("stdDeviation", frost.toFixed(2))
    for (const node of [this.filter, this.map]) {
      node.setAttribute("width", w.toFixed(2))
      node.setAttribute("height", h.toFixed(2))
    }
    const style = this.element.style
    style.display = "block"
    style.left = `${(ISLAND_CANVAS_W / 2 - w / 2).toFixed(2)}px`
    style.top = `${TOP_Y}px`
    style.width = `${w.toFixed(2)}px`
    style.height = `${h.toFixed(2)}px`
    style.borderRadius = `${r.toFixed(2)}px`
    style.opacity = opacity.toFixed(3)
  }
}

// R/G encode the sampling offset: zero in the flat interior, ramping up across a rim bevel and pointing inward.
function lensMap(canvas: HTMLCanvasElement, w: number, h: number, r: number): string {
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext("2d")
  if (!context) return ""
  const image = context.createImageData(w, h)
  const bx = w / 2
  const by = h / 2
  const rr = Math.min(r, bx, by)
  const bevel = Math.max(4, Math.min(14, h * 0.4))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - bx
      const py = y + 0.5 - by
      const qx = Math.abs(px) - bx + rr
      const qy = Math.abs(py) - by + rr
      let nx = 0
      let ny = 0
      let d: number
      if (qx > 0 && qy > 0) {
        const length = Math.hypot(qx, qy)
        d = length - rr
        nx = (qx / length) * Math.sign(px)
        ny = (qy / length) * Math.sign(py)
      } else if (qx > qy) {
        d = qx - rr
        nx = Math.sign(px)
      } else {
        d = qy - rr
        ny = Math.sign(py)
      }
      const falloff = (1 - clamp01(-d / bevel)) ** 3
      const i = (y * w + x) * 4
      image.data[i] = 128 - nx * falloff * 127
      image.data[i + 1] = 128 - ny * falloff * 127
      image.data[i + 2] = 128
      image.data[i + 3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  return canvas.toDataURL()
}

// The Browser Control mark: the same macOS arrow the ghost cursor uses.
function createMark(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.setAttribute("viewBox", "1.1 0.5 14.4 20.8")
  svg.setAttribute("aria-hidden", "true")
  svg.style.cssText = `position:absolute;left:${ISLAND_CANVAS_W / 2}px;top:0;width:8.3px;height:12px;opacity:0;pointer-events:none;overflow:visible;transform-origin:50% 50%;will-change:transform,opacity;`
  const path = document.createElementNS(SVG_NS, "path")
  path.setAttribute(
    "d",
    "M2.1 1.5 L2.1 17.6 L6.0 13.8 L8.5 19.5 C8.75 20.05 9.4 20.3 9.95 20.05 L11.05 19.55 C11.6 19.3 11.85 18.65 11.6 18.1 L9.1 12.4 L14.5 12.4 L2.1 1.5 Z",
  )
  path.setAttribute("fill", "#f4f3ef")
  path.setAttribute("stroke", "#f4f3ef")
  path.setAttribute("stroke-width", "0.6")
  path.setAttribute("stroke-linejoin", "round")
  svg.append(path)
  return svg
}

// Transform follows the spring; opacity resolves faster and is gated by the room the shape has opened up,
// so content never shows clipped by a half-open island.
function reveal(element: HTMLElement | null, progress: number, room: number, lift: number): void {
  if (!element) return
  element.style.opacity = (smoothstep(0, 0.6, progress) * room).toFixed(3)
  element.style.transform = `translate3d(0, ${((progress - 1) * lift).toFixed(2)}px, 0) scale(${(0.96 + 0.04 * progress).toFixed(4)})`
}
