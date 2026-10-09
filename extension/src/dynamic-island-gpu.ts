// GPU-accelerated Dynamic Island for Browser Control.
// Uses gpu-gallery's 1/480 Hz substep Spring integrator, polynomial smooth-minimum (fsmin)
// metaball splitting, Interleaved Gradient Noise (IGN) shutter motion blur, bioluminescent
// pulse orb (shadeOrb), harmonic working wave (workWave), and 1px hairline proximity lighting.
// Runs on WebGPU (navigator.gpu) with an automatic WebGL2 fallback using identical math.

class Spring {
  v = 0
  target: number
  constructor(
    public x: number,
    public omega = 24,
    public zeta = 0.76,
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

export const ISLAND_CANVAS_W = 540
export const ISLAND_CANVAS_H = 176

const WGSL_SOURCE = /* wgsl */ `
struct Uniforms {
  u0: vec4f, // canvasW, canvasH, dpr, time
  u1: vec4f, // islandW, islandH, radius, topY
  u2: vec4f, // velW, velH, satOffset, satRadius
  u3: vec4f, // cursorX, cursorY, toneMode (0=attached,1=running,2=waiting,3=request), activity
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

fn evalField(p: vec2f, w: f32, h: f32, r: f32, topY: f32, satOff: f32, satR: f32, cursor: vec2f) -> f32 {
  let cMain = vec2f(u.u0.x * 0.5 - satOff * 0.26, topY + h * 0.5);
  let halfSize = max(vec2f(w, h) * 0.5, vec2f(8.0));
  let rr = min(r, min(halfSize.x, halfSize.y));
  var d = sdRoundedBox(p - cMain, halfSize, rr);
  if (satR > 0.5) {
    let cSat = vec2f(cMain.x + halfSize.x + satOff, topY + 18.0);
    let dSat = length(p - cSat) - satR;
    d = fsmin(d, dSat, 17.5);
  }
  let dCursor = length(p - cursor);
  if (dCursor < 78.0 && d < 46.0) {
    d = fsmin(d, dCursor - 6.0, 16.0);
  }
  return d;
}

fn shadeOrb(p: vec2f, center: vec2f, radius: f32, time: f32, activity: f32, tint: vec3f, secTint: vec3f) -> vec4f {
  let p0 = (p - center) / max(radius, 1.0);
  let r = length(p0);
  if (r > 1.35) { return vec4f(0.0); }
  let breathe = 0.5 + 0.5 * sin(time * mix(2.0, 4.6, activity));
  let outerHalo = exp(-r * r * 3.8) * mix(0.26, 0.52, activity);
  let ringSpeed = mix(0.38, 0.96, activity);
  let ph1 = fract(time * ringSpeed);
  let r1 = mix(0.16, 0.86, ph1);
  let ring1 = exp(-pow((r - r1) / 0.065, 2.0)) * (1.0 - ph1) * (1.0 - ph1) * 0.58;
  let ph2 = fract(time * ringSpeed + 0.5);
  let r2 = mix(0.16, 0.86, ph2);
  let ring2 = exp(-pow((r - r2) / 0.065, 2.0)) * (1.0 - ph2) * (1.0 - ph2) * 0.44;
  let coreR = 0.24 * (0.95 + 0.08 * breathe);
  let midGlow = exp(-(r * r) / (coreR * coreR * 2.8)) * 0.88;
  let innerCore = smoothstep(coreR, coreR * 0.2, r);
  let satAng = time * mix(2.8, 5.8, activity);
  let satPos = vec2f(cos(satAng), sin(satAng) * 0.78) * 0.48;
  let dSat = length(p0 - satPos);
  let satGlow = exp(-dSat * dSat * 85.0) * 0.85 * activity;
  let bodyTint = mix(tint, secTint, clamp(0.5 + p0.x * 0.6, 0.0, 1.0));
  let rgb = bodyTint * (outerHalo + midGlow * 0.75) + secTint * (ring1 + ring2) + vec3f(0.98, 0.99, 1.0) * (innerCore + satGlow);
  let a = clamp(outerHalo + midGlow * 0.8 + ring1 + ring2 + innerCore + satGlow, 0.0, 1.0) * smoothstep(1.35, 0.75, r);
  return vec4f(min(rgb, vec3f(1.0)) * a, a);
}

fn shadeWorkWave(p: vec2f, center: vec2f, radius: f32, time: f32, tint: vec3f) -> vec4f {
  let local = p - (center - vec2f(radius * 0.72, radius * 0.55));
  let size = vec2f(radius * 1.44, radius * 1.1);
  let uCoord = local.x / max(size.x, 1.0);
  if (uCoord < 0.0 || uCoord > 1.0 || abs(local.y - size.y * 0.5) > radius) { return vec4f(0.0); }
  let env = pow(max(sin(3.14159265 * clamp(uCoord, 0.0, 1.0)), 0.0), 0.75);
  let amp = size.y * 0.34;
  var line = 0.0;
  var glows = array<f32, 3>(0.0, 0.0, 0.0);
  for (var i = 0; i < 3; i++) {
    let fi = f32(i);
    let k = 6.2831853 * (1.25 + 0.38 * fi) / size.x;
    let om = 2.8 + 0.65 * fi;
    let arg = local.x * k - time * om + fi * 1.7;
    let y = size.y * 0.5 + amp * env * sin(arg);
    let slope = amp * env * cos(arg) * k;
    let d = abs(local.y - y) / sqrt(1.0 + slope * slope);
    line += (1.0 - smoothstep(0.45, 1.25, d)) * (0.56 - 0.08 * fi);
    glows[i] = exp(-d * d / 2.2);
  }
  let cross = glows[0] * glows[1] + glows[1] * glows[2] + glows[0] * glows[2];
  let a = clamp((line + cross * 0.55) * env, 0.0, 1.0);
  let rgb = mix(tint, vec3f(0.97, 1.0, 0.99), clamp(cross * 0.9, 0.0, 1.0));
  return vec4f(rgb * a, a);
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let p = in.uv * u.u0.xy;
  let dpr = max(u.u0.z, 1.0);
  let time = u.u0.w;
  let w = u.u1.x;
  let h = u.u1.y;
  let r = u.u1.z;
  let topY = u.u1.w;
  let velW = u.u2.x;
  let velH = u.u2.y;
  let satOff = u.u2.z;
  let satR = u.u2.w;
  let cursor = u.u3.xy;
  let tone = u.u3.z;
  let activity = clamp(u.u3.w, 0.0, 1.2);

  let cMain = vec2f(u.u0.x * 0.5 - satOff * 0.26, topY + h * 0.5);
  let cSat = vec2f(cMain.x + w * 0.5 + satOff, topY + 18.0);
  let orbCenter = vec2f(cMain.x - w * 0.5 + 18.0, topY + 18.0);

  // Interleaved Gradient Noise shutter motion blur across morph velocity
  let blurVec = vec2f(velW, velH) * 0.032;
  let blurMag = length(blurVec);
  var d = 0.0;
  var cov = 0.0;
  if (blurMag > 0.35) {
    let ign = fract(52.9829189 * fract(dot(in.pos.xy, vec2f(0.06711056, 0.00583715))));
    let samples = 11;
    var accCov = 0.0;
    var midD = 0.0;
    for (var k = 0; k < samples; k++) {
      let f = (f32(k) + ign) / f32(samples) - 0.5;
      let dk = evalField(p, max(40.0, w + blurVec.x * f), max(24.0, h + blurVec.y * f), r, topY, max(0.0, satOff + blurVec.x * 0.32 * f), satR, cursor);
      accCov += clamp(0.5 - dk * dpr, 0.0, 1.0);
      if (k == 5) { midD = dk; }
    }
    cov = accCov / f32(samples);
    d = midD;
  } else {
    d = evalField(p, w, h, r, topY, satOff, satR, cursor);
    cov = clamp(0.5 - d * dpr, 0.0, 1.0);
  }

  // Soft ambient drop shadow below the Dynamic Island
  let dShadow = evalField(p - vec2f(0.0, 5.5), w, h, r, topY, satOff, satR, cursor);
  let shadowAlpha = (1.0 - smoothstep(-6.0, 16.0, dShadow)) * 0.46;

  if (cov <= 0.001) {
    return vec4f(0.0, 0.0, 0.0, shadowAlpha);
  }

  // Palette by tone: 0=attached (emerald), 1=running (mint/cyan), 2=waiting (sapphire/indigo), 3=request (amber/gold)
  var tint = vec3f(0.38, 0.90, 0.66);
  var secTint = vec3f(0.44, 0.91, 0.96);
  if (tone > 1.5 && tone < 2.5) {
    tint = vec3f(0.38, 0.65, 1.0);
    secTint = vec3f(0.68, 0.55, 0.98);
  } else if (tone >= 2.5) {
    tint = vec3f(0.98, 0.75, 0.24);
    secTint = vec3f(0.99, 0.56, 0.38);
  }

  // 3D bevel normal & 1px specular hairline (from gpu-gallery shadeCard)
  let eps = 0.8;
  let gx = evalField(p + vec2f(eps, 0.0), w, h, r, topY, satOff, satR, cursor) - d;
  let gy = evalField(p + vec2f(0.0, eps), w, h, r, topY, satOff, satR, cursor) - d;
  let bevelH = clamp(-d / 9.0, 0.0, 1.0);
  let N = normalize(vec3f(normalize(vec2f(gx, gy) + vec2f(1e-5)) * (1.0 - bevelH) * 0.9, sqrt(bevelH) + 0.22));
  let L = normalize(vec3f(-0.4, -0.7, 0.58));
  let spec = pow(max(dot(reflect(-L, N), vec3f(0.0, 0.0, 1.0)), 0.0), 28.0);

  let hairMask = clamp(1.0 - abs(d * dpr + 0.85), 0.0, 1.0);
  let topGloss = (1.0 - smoothstep(topY, topY + h * 0.55, p.y)) * 0.045;
  var rgb = vec3f(0.048, 0.050, 0.058) + vec3f(topGloss + spec * 0.14 + hairMask * 0.14);

  // Proximity lighting from the left bioluminescent orb
  let dnOrb = length(p - orbCenter) / 88.0;
  let orbBorderGlow = exp(-dnOrb * dnOrb * 1.85);
  let orbSurfaceGlow = exp(-dnOrb * dnOrb * 3.1) * 0.065;
  rgb += tint * (orbSurfaceGlow + hairMask * orbBorderGlow * 0.68);

  // Proximity lighting from the right satellite pod (when detached)
  if (satR > 1.0) {
    let dnSat = length(p - cSat) / 64.0;
    let satGlow = exp(-dnSat * dnSat * 2.1);
    rgb += secTint * (satGlow * 0.045 + hairMask * satGlow * 0.55);
  }

  // Proximity catchlight from the Ghost Cursor / pointer
  let dnCur = length(p - cursor) / 120.0;
  if (dnCur < 1.8) {
    let curGlow = exp(-dnCur * dnCur * 2.0);
    rgb += mix(secTint, vec3f(1.0), 0.45) * (curGlow * 0.05 + hairMask * curGlow * 0.75);
  }

  // Composite the left bioluminescent orb inside the capsule
  let orb = shadeOrb(p, orbCenter, 9.5, time, activity, tint, secTint);
  rgb = rgb * (1.0 - orb.a) + orb.rgb;

  // Composite the harmonic working wave inside the satellite pod when running
  if (satR > 4.0) {
    let wave = shadeWorkWave(p, cSat, satR * 0.78, time, secTint);
    rgb = rgb * (1.0 - wave.a) + wave.rgb;
  }

  let bodyPremul = vec4f(min(rgb, vec3f(1.0)) * cov, cov);
  let shadowPremul = vec4f(0.0, 0.0, 0.0, shadowAlpha);
  return bodyPremul + shadowPremul * (1.0 - cov);
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
uniform vec4 u2; // velW, velH, satOffset, satRadius
uniform vec4 u3; // cursorX, cursorY, toneMode, activity

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

float fsmin(float a, float b, float k) {
  if (k <= 0.001) return min(a, b);
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float evalField(vec2 p, float w, float h, float r, float topY, float satOff, float satR, vec2 cursor) {
  vec2 cMain = vec2(u0.x * 0.5 - satOff * 0.26, topY + h * 0.5);
  vec2 halfSize = max(vec2(w, h) * 0.5, vec2(8.0));
  float rr = min(r, min(halfSize.x, halfSize.y));
  float d = sdRoundedBox(p - cMain, halfSize, rr);
  if (satR > 0.5) {
    vec2 cSat = vec2(cMain.x + halfSize.x + satOff, topY + 18.0);
    float dSat = length(p - cSat) - satR;
    d = fsmin(d, dSat, 17.5);
  }
  float dCursor = length(p - cursor);
  if (dCursor < 78.0 && d < 46.0) {
    d = fsmin(d, dCursor - 6.0, 16.0);
  }
  return d;
}

vec4 shadeOrb(vec2 p, vec2 center, float radius, float time, float activity, vec3 tint, vec3 secTint) {
  vec2 p0 = (p - center) / max(radius, 1.0);
  float r = length(p0);
  if (r > 1.35) return vec4(0.0);
  float breathe = 0.5 + 0.5 * sin(time * mix(2.0, 4.6, activity));
  float outerHalo = exp(-r * r * 3.8) * mix(0.26, 0.52, activity);
  float ringSpeed = mix(0.38, 0.96, activity);
  float ph1 = fract(time * ringSpeed);
  float r1 = mix(0.16, 0.86, ph1);
  float ring1 = exp(-pow((r - r1) / 0.065, 2.0)) * (1.0 - ph1) * (1.0 - ph1) * 0.58;
  float ph2 = fract(time * ringSpeed + 0.5);
  float r2 = mix(0.16, 0.86, ph2);
  float ring2 = exp(-pow((r - r2) / 0.065, 2.0)) * (1.0 - ph2) * (1.0 - ph2) * 0.44;
  float coreR = 0.24 * (0.95 + 0.08 * breathe);
  float midGlow = exp(-(r * r) / (coreR * coreR * 2.8)) * 0.88;
  float innerCore = smoothstep(coreR, coreR * 0.2, r);
  float satAng = time * mix(2.8, 5.8, activity);
  vec2 satPos = vec2(cos(satAng), sin(satAng) * 0.78) * 0.48;
  float dSat = length(p0 - satPos);
  float satGlow = exp(-dSat * dSat * 85.0) * 0.85 * activity;
  vec3 bodyTint = mix(tint, secTint, clamp(0.5 + p0.x * 0.6, 0.0, 1.0));
  vec3 rgb = bodyTint * (outerHalo + midGlow * 0.75) + secTint * (ring1 + ring2) + vec3(0.98, 0.99, 1.0) * (innerCore + satGlow);
  float a = clamp(outerHalo + midGlow * 0.8 + ring1 + ring2 + innerCore + satGlow, 0.0, 1.0) * smoothstep(1.35, 0.75, r);
  return vec4(min(rgb, vec3(1.0)) * a, a);
}

vec4 shadeWorkWave(vec2 p, vec2 center, float radius, float time, vec3 tint) {
  vec2 local = p - (center - vec2(radius * 0.72, radius * 0.55));
  vec2 size = vec2(radius * 1.44, radius * 1.1);
  float uCoord = local.x / max(size.x, 1.0);
  if (uCoord < 0.0 || uCoord > 1.0 || abs(local.y - size.y * 0.5) > radius) return vec4(0.0);
  float env = pow(max(sin(3.14159265 * clamp(uCoord, 0.0, 1.0)), 0.0), 0.75);
  float amp = size.y * 0.34;
  float line = 0.0;
  float g0 = 0.0, g1 = 0.0, g2 = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float k = 6.2831853 * (1.25 + 0.38 * fi) / size.x;
    float om = 2.8 + 0.65 * fi;
    float arg = local.x * k - time * om + fi * 1.7;
    float y = size.y * 0.5 + amp * env * sin(arg);
    float slope = amp * env * cos(arg) * k;
    float d = abs(local.y - y) / sqrt(1.0 + slope * slope);
    line += (1.0 - smoothstep(0.45, 1.25, d)) * (0.56 - 0.08 * fi);
    float g = exp(-d * d / 2.2);
    if (i == 0) g0 = g; else if (i == 1) g1 = g; else g2 = g;
  }
  float crossG = g0 * g1 + g1 * g2 + g0 * g2;
  float a = clamp((line + crossG * 0.55) * env, 0.0, 1.0);
  vec3 rgb = mix(tint, vec3(0.97, 1.0, 0.99), clamp(crossG * 0.9, 0.0, 1.0));
  return vec4(rgb * a, a);
}

void main() {
  vec2 p = v_uv * u0.xy;
  float dpr = max(u0.z, 1.0);
  float time = u0.w;
  float w = u1.x, h = u1.y, r = u1.z, topY = u1.w;
  float velW = u2.x, velH = u2.y, satOff = u2.z, satR = u2.w;
  vec2 cursor = u3.xy;
  float tone = u3.z;
  float activity = clamp(u3.w, 0.0, 1.2);

  vec2 cMain = vec2(u0.x * 0.5 - satOff * 0.26, topY + h * 0.5);
  vec2 cSat = vec2(cMain.x + w * 0.5 + satOff, topY + 18.0);
  vec2 orbCenter = vec2(cMain.x - w * 0.5 + 18.0, topY + 18.0);

  vec2 blurVec = vec2(velW, velH) * 0.032;
  float blurMag = length(blurVec);
  float d = 0.0;
  float cov = 0.0;
  if (blurMag > 0.35) {
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float accCov = 0.0;
    float midD = 0.0;
    for (int k = 0; k < 11; k++) {
      float f = (float(k) + ign) / 11.0 - 0.5;
      float dk = evalField(p, max(40.0, w + blurVec.x * f), max(24.0, h + blurVec.y * f), r, topY, max(0.0, satOff + blurVec.x * 0.32 * f), satR, cursor);
      accCov += clamp(0.5 - dk * dpr, 0.0, 1.0);
      if (k == 5) midD = dk;
    }
    cov = accCov / 11.0;
    d = midD;
  } else {
    d = evalField(p, w, h, r, topY, satOff, satR, cursor);
    cov = clamp(0.5 - d * dpr, 0.0, 1.0);
  }

  float dShadow = evalField(p - vec2(0.0, 5.5), w, h, r, topY, satOff, satR, cursor);
  float shadowAlpha = (1.0 - smoothstep(-6.0, 16.0, dShadow)) * 0.46;

  if (cov <= 0.001) {
    fragColor = vec4(0.0, 0.0, 0.0, shadowAlpha);
    return;
  }

  vec3 tint = vec3(0.38, 0.90, 0.66);
  vec3 secTint = vec3(0.44, 0.91, 0.96);
  if (tone > 1.5 && tone < 2.5) {
    tint = vec3(0.38, 0.65, 1.0);
    secTint = vec3(0.68, 0.55, 0.98);
  } else if (tone >= 2.5) {
    tint = vec3(0.98, 0.75, 0.24);
    secTint = vec3(0.99, 0.56, 0.38);
  }

  float eps = 0.8;
  float gx = evalField(p + vec2(eps, 0.0), w, h, r, topY, satOff, satR, cursor) - d;
  float gy = evalField(p + vec2(0.0, eps), w, h, r, topY, satOff, satR, cursor) - d;
  float bevelH = clamp(-d / 9.0, 0.0, 1.0);
  vec3 N = normalize(vec3(normalize(vec2(gx, gy) + vec2(1e-5)) * (1.0 - bevelH) * 0.9, sqrt(bevelH) + 0.22));
  vec3 L = normalize(vec3(-0.4, -0.7, 0.58));
  float spec = pow(max(dot(reflect(-L, N), vec3(0.0, 0.0, 1.0)), 0.0), 28.0);

  float hairMask = clamp(1.0 - abs(d * dpr + 0.85), 0.0, 1.0);
  float topGloss = (1.0 - smoothstep(topY, topY + h * 0.55, p.y)) * 0.045;
  vec3 rgb = vec3(0.048, 0.050, 0.058) + vec3(topGloss + spec * 0.14 + hairMask * 0.14);

  float dnOrb = length(p - orbCenter) / 88.0;
  float orbBorderGlow = exp(-dnOrb * dnOrb * 1.85);
  float orbSurfaceGlow = exp(-dnOrb * dnOrb * 3.1) * 0.065;
  rgb += tint * (orbSurfaceGlow + hairMask * orbBorderGlow * 0.68);

  if (satR > 1.0) {
    float dnSat = length(p - cSat) / 64.0;
    float satGlow = exp(-dnSat * dnSat * 2.1);
    rgb += secTint * (satGlow * 0.045 + hairMask * satGlow * 0.55);
  }

  float dnCur = length(p - cursor) / 120.0;
  if (dnCur < 1.8) {
    float curGlow = exp(-dnCur * dnCur * 2.0);
    rgb += mix(secTint, vec3(1.0), 0.45) * (curGlow * 0.05 + hairMask * curGlow * 0.75);
  }

  vec4 orb = shadeOrb(p, orbCenter, 9.5, time, activity, tint, secTint);
  rgb = rgb * (1.0 - orb.a) + orb.rgb;

  if (satR > 4.0) {
    vec4 wave = shadeWorkWave(p, cSat, satR * 0.78, time, secTint);
    rgb = rgb * (1.0 - wave.a) + wave.rgb;
  }

  vec4 bodyPremul = vec4(min(rgb, vec3(1.0)) * cov, cov);
  vec4 shadowPremul = vec4(0.0, 0.0, 0.0, shadowAlpha);
  fragColor = bodyPremul + shadowPremul * (1.0 - cov);
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
      usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
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

export class DynamicIslandRig {
  readonly w = new Spring(192, 19, 0.66)
  readonly h = new Spring(34, 19, 0.68)
  readonly r = new Spring(17, 22, 0.78)
  readonly topY = new Spring(10, 22, 0.76)
  readonly satOffset = new Spring(0, 18, 0.62)
  readonly satRadius = new Spring(0, 20, 0.68)
  readonly defocus = new Spring(0, 26, 0.82)
  readonly activity = new Spring(0.25, 16, 0.85)
  toneMode = 0
  private backend: GpuBackend | null = null
  private initializing = false
  private rafId = 0
  private lastTime = 0
  private readonly uniforms = new Float32Array(16)
  private lastSignature = ""
  private pointerX = -999
  private pointerY = -999

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly contentEl: HTMLElement,
  ) {
    this.syncCanvasResolution()
    void this.ensureBackend()
    window.addEventListener("pointermove", this.onPointerMove, { passive: true })
  }

  private readonly onPointerMove = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect()
    this.pointerX = e.clientX - rect.left
    this.pointerY = e.clientY - rect.top
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
    readonly label: string
    readonly message?: string
  }): void {
    const signature = `${options.tone}:${options.isTabRequest}:${options.label}:${options.message ?? ""}`
    if (signature !== this.lastSignature) {
      if (this.lastSignature !== "") {
        this.defocus.v = 110
      }
      this.lastSignature = signature
    }
    const labelWidth = Math.min(340, Math.max(148, options.label.length * 7.2 + 54))
    if (options.tone === "waiting") {
      const msgLen = (options.message ?? "").length
      const targetW = Math.min(412, Math.max(320, Math.min(msgLen * 6.2 + 80, 396)))
      const targetH = msgLen > 48 ? 108 : 96
      this.w.set(targetW)
      this.h.set(targetH)
      this.r.set(24)
      this.topY.set(12)
      this.satOffset.set(0)
      this.satRadius.set(0)
      this.activity.set(0.95)
      this.toneMode = options.isTabRequest ? 3 : 2
    } else if (options.tone === "running") {
      this.w.set(labelWidth)
      this.h.set(36)
      this.r.set(18)
      this.topY.set(10)
      this.satOffset.set(22)
      this.satRadius.set(16)
      this.activity.set(1.0)
      this.toneMode = 1
    } else {
      this.w.set(labelWidth)
      this.h.set(34)
      this.r.set(17)
      this.topY.set(10)
      this.satOffset.set(0)
      this.satRadius.set(0)
      this.activity.set(0.28)
      this.toneMode = 0
    }
    this.startLoop()
  }

  startLoop(): void {
    if (this.rafId) return
    this.lastTime = performance.now()
    const tick = (now: number) => {
      this.rafId = 0
      const dt = Math.min(0.05, Math.max(1 / 240, (now - this.lastTime) / 1000))
      this.lastTime = now
      const w = this.w.step(dt)
      const h = this.h.step(dt)
      const r = this.r.step(dt)
      const topY = this.topY.step(dt)
      const satOff = this.satOffset.step(dt)
      const satR = this.satRadius.step(dt)
      const defocus = Math.max(0, this.defocus.step(dt))
      const act = this.activity.step(dt)

      const mainCenterX = ISLAND_CANVAS_W * 0.5 - satOff * 0.26
      this.contentEl.style.width = `${w.toFixed(1)}px`
      this.contentEl.style.height = `${h.toFixed(1)}px`
      this.contentEl.style.left = `${(mainCenterX - w * 0.5).toFixed(1)}px`
      this.contentEl.style.top = `${topY.toFixed(1)}px`
      this.contentEl.style.borderRadius = `${r.toFixed(1)}px`
      this.contentEl.style.filter = defocus > 0.15 ? `blur(${Math.min(4.5, defocus * 0.18).toFixed(2)}px)` : ""

      let curX = this.pointerX
      let curY = this.pointerY
      const ghost = document.getElementById("__browser_control_ghost_cursor__")
      if (ghost) {
        const gx = Number(ghost.dataset.renderedX ?? ghost.dataset.targetX)
        const gy = Number(ghost.dataset.renderedY ?? ghost.dataset.targetY)
        if (Number.isFinite(gx) && Number.isFinite(gy)) {
          const rect = this.canvas.getBoundingClientRect()
          curX = gx - rect.left
          curY = gy - rect.top
        }
      }

      if (this.backend) {
        const dpr = this.syncCanvasResolution()
        const u = this.uniforms
        u[0] = ISLAND_CANVAS_W
        u[1] = ISLAND_CANVAS_H
        u[2] = dpr
        u[3] = now / 1000
        u[4] = w
        u[5] = h
        u[6] = r
        u[7] = topY
        u[8] = this.w.v
        u[9] = this.h.v
        u[10] = satOff
        u[11] = satR
        u[12] = curX
        u[13] = curY
        u[14] = this.toneMode
        u[15] = act
        this.backend.draw(u)
      }

      const animating =
        this.toneMode >= 1 ||
        !this.w.resting ||
        !this.h.resting ||
        !this.satOffset.resting ||
        !this.satRadius.resting ||
        !this.defocus.resting
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
    window.removeEventListener("pointermove", this.onPointerMove)
  }
}
