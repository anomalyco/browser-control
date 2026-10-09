// GPU-accelerated Dynamic Island for Browser Control.
// Clean, fixed-width states, smooth critically-damped 1/480 Hz spring transitions,
// transient fsmin metaball split/merge, and razor-sharp 2x Retina anti-aliased SDF rendering.

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

export const ISLAND_CANVAS_W = 520
export const ISLAND_CANVAS_H = 148

const RUNNING_W = 184
const RUNNING_H = 32
const ATTACHED_W = 164
const ATTACHED_H = 30
const WAITING_W = 344
const WAITING_H = 92

const WGSL_SOURCE = /* wgsl */ `
struct Uniforms {
  u0: vec4f, // canvasW, canvasH, dpr, time
  u1: vec4f, // islandW, islandH, radius, topY
  u2: vec4f, // satGap, satRadius, toneMode (0=attached,1=running,2=waiting,3=request), activity
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

fn fsmin(a: f32, b: f32, k: f32) -> f32 {
  if (k <= 0.001) { return min(a, b); }
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

fn evalField(p: vec2f, w: f32, h: f32, r: f32, topY: f32, satGap: f32, satR: f32) -> f32 {
  let totalShift = max(0.0, satGap + satR * 2.0) * 0.5;
  let cMain = vec2f(u.u0.x * 0.5 - totalShift, topY + h * 0.5);
  let halfSize = max(vec2f(w, h) * 0.5, vec2f(8.0));
  let rr = min(r, min(halfSize.x, halfSize.y));
  var d = sdRoundedBox(p - cMain, halfSize, rr);
  if (satR > 0.5) {
    let cSat = vec2f(cMain.x + halfSize.x + satGap + satR, topY + h * 0.5);
    let dSat = length(p - cSat) - satR;
    let kBridge = 10.5 * (1.0 - smoothstep(0.5, 5.5, satGap)) * clamp(satR / 14.0, 0.0, 1.0);
    d = fsmin(d, dSat, kBridge);
  }
  return d;
}

fn shadeStatusDot(p: vec2f, center: vec2f, dpr: f32, tint: vec3f) -> vec4f {
  let d = length(p - center);
  if (d > 6.0) { return vec4f(0.0); }
  let aa = 0.6 / dpr;
  let core = 1.0 - smoothstep(3.0 - aa, 3.0 + aa, d);
  return vec4f(tint * core, core);
}

fn shadeSpinner(p: vec2f, center: vec2f, radius: f32, dpr: f32, time: f32, tint: vec3f) -> vec4f {
  let q = p - center;
  let rad = length(q);
  if (rad > radius + 2.0) { return vec4f(0.0); }
  let aa = 0.6 / dpr;
  let strokeW = 1.55;
  let R = radius - 1.2;
  let ring = 1.0 - smoothstep(strokeW * 0.5 - aa, strokeW * 0.5 + aa, abs(rad - R));
  let head = fract(time * 0.85);
  let ang = atan2(q.x, -q.y) / 6.2831853;
  let behind = fract(head - ang);
  let arc = exp(-behind * 4.8) * ring;
  let hp = vec2f(sin(head * 6.2831853), -cos(head * 6.2831853)) * R;
  let hd = length(q - hp);
  let cap = 1.0 - smoothstep(strokeW * 0.6 - aa, strokeW * 0.6 + aa, hd);
  let track = ring * 0.16;
  let a = clamp(track + arc * 0.9 + cap, 0.0, 1.0);
  return vec4f(tint * a, a);
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let p = in.uv * u.u0.xy;
  let dpr = max(u.u0.z, 1.0);
  let time = u.u0.w;
  let w = u.u1.x;
  let h = u.u1.y;
  let r = u.u1.z;
  let topY = u.u1.w;
  let satGap = u.u2.x;
  let satR = u.u2.y;
  let tone = u.u2.z;

  let totalShift = max(0.0, satGap + satR * 2.0) * 0.5;
  let cMain = vec2f(u.u0.x * 0.5 - totalShift, topY + h * 0.5);
  let cSat = vec2f(cMain.x + w * 0.5 + satGap + satR, topY + h * 0.5);
  let orbCenter = vec2f(cMain.x - w * 0.5 + 15.0, topY + 16.0);

  let d = evalField(p, w, h, r, topY, satGap, satR);
  let cov = clamp(0.5 - d * dpr, 0.0, 1.0);
  if (cov <= 0.001) {
    return vec4f(0.0);
  }

  var dotTint = vec3f(0.68, 0.78, 0.65);
  if (tone > 1.5) {
    dotTint = vec3f(0.88, 0.73, 0.44);
  }
  let ivory = vec3f(0.95, 0.94, 0.91);

  // Uniform #0a0a0c carbon fill with a static, even 1px hairline border (no shimmer!)
  let hairMask = clamp(1.0 - abs(d * dpr + 0.75), 0.0, 1.0);
  var rgb = vec3f(0.039, 0.039, 0.045) + ivory * hairMask * 0.14;

  let dotCol = shadeStatusDot(p, orbCenter, dpr, dotTint);
  rgb = rgb * (1.0 - dotCol.a) + dotCol.rgb;

  if (satR > 4.0) {
    let ind = shadeSpinner(p, cSat, satR * 0.54, dpr, time, ivory);
    rgb = rgb * (1.0 - ind.a) + ind.rgb;
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
uniform vec4 u2; // satGap, satRadius, toneMode, activity

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

float fsmin(float a, float b, float k) {
  if (k <= 0.001) return min(a, b);
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float evalField(vec2 p, float w, float h, float r, float topY, float satGap, float satR) {
  float totalShift = max(0.0, satGap + satR * 2.0) * 0.5;
  vec2 cMain = vec2(u0.x * 0.5 - totalShift, topY + h * 0.5);
  vec2 halfSize = max(vec2(w, h) * 0.5, vec2(8.0));
  float rr = min(r, min(halfSize.x, halfSize.y));
  float d = sdRoundedBox(p - cMain, halfSize, rr);
  if (satR > 0.5) {
    vec2 cSat = vec2(cMain.x + halfSize.x + satGap + satR, topY + h * 0.5);
    float dSat = length(p - cSat) - satR;
    float kBridge = 10.5 * (1.0 - smoothstep(0.5, 5.5, satGap)) * clamp(satR / 14.0, 0.0, 1.0);
    d = fsmin(d, dSat, kBridge);
  }
  return d;
}

vec4 shadeStatusDot(vec2 p, vec2 center, float dpr, vec3 tint) {
  float d = length(p - center);
  if (d > 6.0) return vec4(0.0);
  float aa = 0.6 / dpr;
  float core = 1.0 - smoothstep(3.0 - aa, 3.0 + aa, d);
  return vec4(tint * core, core);
}

vec4 shadeSpinner(vec2 p, vec2 center, float radius, float dpr, float time, vec3 tint) {
  vec2 q = p - center;
  float rad = length(q);
  if (rad > radius + 2.0) return vec4(0.0);
  float aa = 0.6 / dpr;
  float strokeW = 1.55;
  float R = radius - 1.2;
  float ring = 1.0 - smoothstep(strokeW * 0.5 - aa, strokeW * 0.5 + aa, abs(rad - R));
  float head = fract(time * 0.85);
  float ang = atan(q.x, -q.y) / 6.2831853;
  float behind = fract(head - ang);
  float arc = exp(-behind * 4.8) * ring;
  vec2 hp = vec2(sin(head * 6.2831853), -cos(head * 6.2831853)) * R;
  float hd = length(q - hp);
  float cap = 1.0 - smoothstep(strokeW * 0.6 - aa, strokeW * 0.6 + aa, hd);
  float track = ring * 0.16;
  float a = clamp(track + arc * 0.9 + cap, 0.0, 1.0);
  return vec4(tint * a, a);
}

void main() {
  vec2 p = v_uv * u0.xy;
  float dpr = max(u0.z, 1.0);
  float time = u0.w;
  float w = u1.x, h = u1.y, r = u1.z, topY = u1.w;
  float satGap = u2.x, satR = u2.y, tone = u2.z;

  float totalShift = max(0.0, satGap + satR * 2.0) * 0.5;
  vec2 cMain = vec2(u0.x * 0.5 - totalShift, topY + h * 0.5);
  vec2 cSat = vec2(cMain.x + w * 0.5 + satGap + satR, topY + h * 0.5);
  vec2 orbCenter = vec2(cMain.x - w * 0.5 + 15.0, topY + 16.0);

  float d = evalField(p, w, h, r, topY, satGap, satR);
  float cov = clamp(0.5 - d * dpr, 0.0, 1.0);
  if (cov <= 0.001) {
    fragColor = vec4(0.0);
    return;
  }

  vec3 dotTint = vec3(0.68, 0.78, 0.65);
  if (tone > 1.5) {
    dotTint = vec3(0.88, 0.73, 0.44);
  }
  vec3 ivory = vec3(0.95, 0.94, 0.91);

  float hairMask = clamp(1.0 - abs(d * dpr + 0.75), 0.0, 1.0);
  vec3 rgb = vec3(0.039, 0.039, 0.045) + ivory * hairMask * 0.14;

  vec4 dotCol = shadeStatusDot(p, orbCenter, dpr, dotTint);
  rgb = rgb * (1.0 - dotCol.a) + dotCol.rgb;

  if (satR > 4.0) {
    vec4 ind = shadeSpinner(p, cSat, satR * 0.54, dpr, time, ivory);
    rgb = rgb * (1.0 - ind.a) + ind.rgb;
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
  readonly w = new Spring(ATTACHED_W, 20, 0.88)
  readonly h = new Spring(ATTACHED_H, 18, 0.88)
  readonly r = new Spring(15, 22, 0.90)
  readonly topY = new Spring(8, 22, 0.90)
  readonly satGap = new Spring(-22, 18, 0.86)
  readonly satRadius = new Spring(0, 20, 0.88)
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

  pulseClick(): void {
    this.startLoop()
  }

  configure(options: {
    readonly tone: "active" | "running" | "waiting"
    readonly isTabRequest: boolean
    readonly label: string
    readonly message?: string
    readonly workStyle?: number
  }): void {
    if (options.tone === "waiting") {
      this.w.set(WAITING_W)
      this.h.set(WAITING_H)
      this.r.set(22)
      this.topY.set(10)
      this.satGap.set(-24)
      this.satRadius.set(0)
      this.toneMode = options.isTabRequest ? 3 : 2
    } else if (options.tone === "running") {
      this.w.set(RUNNING_W)
      this.h.set(RUNNING_H)
      this.r.set(16)
      this.topY.set(8)
      this.satGap.set(7)
      this.satRadius.set(16)
      this.toneMode = 1
    } else {
      this.w.set(ATTACHED_W)
      this.h.set(ATTACHED_H)
      this.r.set(15)
      this.topY.set(8)
      this.satGap.set(-24)
      this.satRadius.set(0)
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
    const satGap = this.satGap.step(dt)
    const satR = this.satRadius.step(dt)

    const totalShift = Math.max(0, satGap + satR * 2) * 0.5
    const mainCenterX = ISLAND_CANVAS_W * 0.5 - totalShift
    this.contentEl.style.width = `${w.toFixed(1)}px`
    this.contentEl.style.height = `${h.toFixed(1)}px`
    this.contentEl.style.left = `${(mainCenterX - w * 0.5).toFixed(1)}px`
    this.contentEl.style.top = `${topY.toFixed(1)}px`
    this.contentEl.style.borderRadius = `${r.toFixed(1)}px`

    if (this.backend) {
      const dpr = this.syncCanvasResolution()
      const u = this.uniforms
      u[0] = ISLAND_CANVAS_W
      u[1] = ISLAND_CANVAS_H
      u[2] = dpr
      u[3] = this.simTime
      u[4] = w
      u[5] = h
      u[6] = r
      u[7] = topY
      u[8] = satGap
      u[9] = satR
      u[10] = this.toneMode
      u[11] = 1
      this.backend.draw(u)
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
        !this.h.resting ||
        !this.satGap.resting ||
        !this.satRadius.resting
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
