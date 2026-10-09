// GPU-accelerated Dynamic Island for Browser Control.
// Uses gpu-gallery's 1/480 Hz substep Spring integrator, transient smooth-minimum (fsmin)
// metaball bridge during split/merge, 11-sample Interleaved Gradient Noise (IGN) shutter
// motion blur during high-velocity morphs, and crisp geometric indicators (shadeSpinner / workMatrix).

class Spring {
  v = 0
  target: number
  constructor(
    public x: number,
    public omega = 22,
    public zeta = 0.74,
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

export const ISLAND_CANVAS_W = 560
export const ISLAND_CANVAS_H = 168

const WGSL_SOURCE = /* wgsl */ `
struct Uniforms {
  u0: vec4f, // canvasW, canvasH, dpr, time
  u1: vec4f, // islandW, islandH, radius, topY
  u2: vec4f, // velW, velH, satGap, satRadius
  u3: vec4f, // cursorX, cursorY, toneMode (0=attached,1=running,2=waiting,3=request), activity
  u4: vec4f, // workStyle (0=spinner,1=matrix), sheenPhase, clickPulse, pad
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

fn minJerk(x: f32) -> f32 {
  let uVal = clamp(x, 0.0, 1.0);
  return uVal * uVal * uVal * (10.0 + uVal * (6.0 * uVal - 15.0));
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
    // Transient liquid bridge: only active while pinching off or merging (-14px < satGap < 5.5px).
    // At rest (satGap == 7.0px), kBridge is 0.0 so the two shapes are 100% crisp and separate!
    let kBridge = 11.5 * (1.0 - smoothstep(1.0, 5.8, satGap)) * clamp(satR / 14.0, 0.0, 1.0);
    d = fsmin(d, dSat, kBridge);
  }
  return d;
}

// Crisp geometric status dot on the left
fn shadeStatusDot(p: vec2f, center: vec2f, dpr: f32, time: f32, activity: f32, tint: vec3f) -> vec4f {
  let d = length(p - center);
  if (d > 11.0) { return vec4f(0.0); }
  let aa = 0.65 / dpr;
  let breathe = 0.5 + 0.5 * sin(time * 3.2);
  let coreR = 3.2 + 0.25 * breathe * activity;
  let core = 1.0 - smoothstep(coreR - aa, coreR + aa, d);
  let halo = exp(-(d * d) / 22.0) * (0.28 + 0.18 * breathe * activity);
  let ph = fract(time * 0.65);
  let ringR = mix(3.4, 8.8, ph);
  let ring = exp(-pow((d - ringR) / 0.85, 2.0)) * (1.0 - ph) * (1.0 - ph) * 0.55 * activity;
  let rgb = mix(tint, vec3f(0.98, 1.0, 0.99), core * 0.55);
  let a = clamp(core + halo + ring, 0.0, 1.0);
  return vec4f(rgb * a, a);
}

// Crisp Comet Spinner from gpu-gallery tiles.wgsl.ts (kind 10)
fn shadeSpinner(p: vec2f, center: vec2f, radius: f32, dpr: f32, time: f32, tint: vec3f) -> vec4f {
  let q = p - center;
  let rad = length(q);
  if (rad > radius + 2.0) { return vec4f(0.0); }
  let aa = 0.65 / dpr;
  let strokeW = 1.65;
  let R = radius - 1.2;
  let ring = 1.0 - smoothstep(strokeW * 0.5 - aa, strokeW * 0.5 + aa, abs(rad - R));
  let head = fract(time * 0.92);
  let ang = atan2(q.x, -q.y) / 6.2831853;
  let behind = fract(head - ang);
  let arc = exp(-behind * 5.2) * ring;
  let hp = vec2f(sin(head * 6.2831853), -cos(head * 6.2831853)) * R;
  let hd = length(q - hp);
  let cap = 1.0 - smoothstep(strokeW * 0.65 - aa, strokeW * 0.65 + aa, hd);
  let track = ring * 0.16;
  let hot = mix(tint, vec3f(1.0), 0.72);
  let rgb = tint * (track + arc * 0.92) + hot * cap;
  let a = clamp(track + arc * 0.92 + cap, 0.0, 1.0);
  return vec4f(min(rgb, vec3f(1.0)) * a, a);
}

// Crisp 3x3 Dot Matrix from gpu-gallery tiles.wgsl.ts (workMatrix)
fn shadeMatrix(p: vec2f, center: vec2f, radius: f32, dpr: f32, time: f32, tint: vec3f) -> vec4f {
  let span = radius * 1.42;
  let local = p - (center - vec2f(span * 0.5));
  if (any(local < vec2f(0.0)) || any(local > vec2f(span))) { return vec4f(0.0); }
  let cell = span / 3.0;
  let ci = clamp(floor(local / cell), vec2f(0.0), vec2f(2.0));
  let cc = (ci + 0.5) * cell;
  let ph = fract(time * 0.75 - (ci.x + ci.y * 1.4) / 5.2);
  let b = select(minJerk(2.0 - ph * 2.0), minJerk(ph * 2.0), ph < 0.5);
  let bump = pow(b, 2.0);
  let dotR = cell * mix(0.16, 0.34, bump);
  let d = length(local - cc) - dotR;
  let cov = clamp(0.5 - d * dpr, 0.0, 1.0);
  let lum = mix(0.28, 1.0, bump);
  let rgb = mix(tint, vec3f(0.98, 1.0, 0.99), bump * 0.6) * lum;
  let a = cov * lum;
  return vec4f(rgb * cov, a);
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
  let satGap = u.u2.z;
  let satR = u.u2.w;
  let cursor = u.u3.xy;
  let tone = u.u3.z;
  let activity = clamp(u.u3.w, 0.0, 1.3);
  let workStyle = u.u4.x;
  let sheenPhase = u.u4.y;
  let clickPulse = u.u4.z;

  let totalShift = max(0.0, satGap + satR * 2.0) * 0.5;
  let cMain = vec2f(u.u0.x * 0.5 - totalShift, topY + h * 0.5);
  let cSat = vec2f(cMain.x + w * 0.5 + satGap + satR, topY + h * 0.5);
  let orbCenter = vec2f(cMain.x - w * 0.5 + 16.0, topY + 16.0);

  // Interleaved Gradient Noise shutter motion blur ONLY during fast spring transitions
  let blurVec = vec2f(velW, velH) * 0.024;
  let blurMag = length(blurVec);
  var d = 0.0;
  var cov = 0.0;
  if (blurMag > 0.6) {
    let ign = fract(52.9829189 * fract(dot(in.pos.xy, vec2f(0.06711056, 0.00583715))));
    let samples = 9;
    var accCov = 0.0;
    var midD = 0.0;
    for (var k = 0; k < samples; k++) {
      let f = (f32(k) + ign) / f32(samples) - 0.5;
      let dk = evalField(p, max(40.0, w + blurVec.x * f), max(24.0, h + blurVec.y * f), r, topY, satGap + blurVec.x * 0.25 * f, satR);
      accCov += clamp(0.5 - dk * dpr, 0.0, 1.0);
      if (k == 4) { midD = dk; }
    }
    cov = accCov / f32(samples);
    d = midD;
  } else {
    d = evalField(p, w, h, r, topY, satGap, satR);
    cov = clamp(0.5 - d * dpr, 0.0, 1.0);
  }

  // Zero dark halo smudge outside the crisp capsule edge!
  if (cov <= 0.001) {
    return vec4f(0.0);
  }

  var tint = vec3f(0.34, 0.88, 0.64);
  if (tone > 1.5 && tone < 2.5) {
    tint = vec3f(0.36, 0.64, 1.0);
  } else if (tone >= 2.5) {
    tint = vec3f(0.98, 0.72, 0.22);
  }

  // Deep jet-black Apple hardware surface (#09090b) with a crisp 1px inner specular hairline
  let hairMask = clamp(1.0 - abs(d * dpr + 0.75), 0.0, 1.0);
  let topFactor = 1.0 - smoothstep(topY, topY + h * 0.5, p.y);
  var rgb = vec3f(0.035, 0.036, 0.042) + vec3f(topFactor * 0.022);
  var rimAlpha = 0.13 + topFactor * 0.14;

  // Subtle proximity catchlight on the 1px hairline near the status dot & cursor
  let dnOrb = length(p - orbCenter) / 48.0;
  let orbRim = exp(-dnOrb * dnOrb * 2.4) * (0.42 + clickPulse * 0.35);
  rgb += mix(vec3f(1.0), tint, 0.65) * hairMask * (rimAlpha + orbRim);

  let dnCur = length(p - cursor) / 96.0;
  if (dnCur < 1.4) {
    let curRim = exp(-dnCur * dnCur * 2.5) * 0.55;
    rgb += vec3f(0.85, 0.95, 1.0) * hairMask * curRim;
  }

  if (sheenPhase > 0.01 && sheenPhase < 0.99) {
    let sweepX = mix(cMain.x - w * 0.6, cMain.x + w * 0.6, sheenPhase);
    let diag = (p.x - sweepX) + (p.y - topY) * 0.38;
    let ribbon = exp(-(diag * diag) / 280.0) * sin(sheenPhase * 3.14159265);
    rgb += vec3f(1.0) * ribbon * (0.04 + hairMask * 0.45);
  }

  // Left status dot
  let dotCol = shadeStatusDot(p, orbCenter, dpr, time, activity, tint);
  rgb = rgb * (1.0 - dotCol.a) + dotCol.rgb;

  // Right detached satellite indicator (crisp Comet Spinner or 3x3 Matrix)
  if (satR > 4.0) {
    var ind = vec4f(0.0);
    if (round(workStyle) < 0.5) {
      ind = shadeSpinner(p, cSat, satR * 0.56, dpr, time, tint);
    } else {
      ind = shadeMatrix(p, cSat, satR * 0.58, dpr, time, tint);
    }
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
uniform vec4 u2; // velW, velH, satGap, satRadius
uniform vec4 u3; // cursorX, cursorY, toneMode, activity
uniform vec4 u4; // workStyle, sheenPhase, clickPulse, pad

float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

float fsmin(float a, float b, float k) {
  if (k <= 0.001) return min(a, b);
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float minJerk(float x) {
  float uVal = clamp(x, 0.0, 1.0);
  return uVal * uVal * uVal * (10.0 + uVal * (6.0 * uVal - 15.0));
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
    float kBridge = 11.5 * (1.0 - smoothstep(1.0, 5.8, satGap)) * clamp(satR / 14.0, 0.0, 1.0);
    d = fsmin(d, dSat, kBridge);
  }
  return d;
}

vec4 shadeStatusDot(vec2 p, vec2 center, float dpr, float time, float activity, vec3 tint) {
  float d = length(p - center);
  if (d > 11.0) return vec4(0.0);
  float aa = 0.65 / dpr;
  float breathe = 0.5 + 0.5 * sin(time * 3.2);
  float coreR = 3.2 + 0.25 * breathe * activity;
  float core = 1.0 - smoothstep(coreR - aa, coreR + aa, d);
  float halo = exp(-(d * d) / 22.0) * (0.28 + 0.18 * breathe * activity);
  float ph = fract(time * 0.65);
  float ringR = mix(3.4, 8.8, ph);
  float ring = exp(-pow((d - ringR) / 0.85, 2.0)) * (1.0 - ph) * (1.0 - ph) * 0.55 * activity;
  vec3 rgb = mix(tint, vec3(0.98, 1.0, 0.99), core * 0.55);
  float a = clamp(core + halo + ring, 0.0, 1.0);
  return vec4(rgb * a, a);
}

vec4 shadeSpinner(vec2 p, vec2 center, float radius, float dpr, float time, vec3 tint) {
  vec2 q = p - center;
  float rad = length(q);
  if (rad > radius + 2.0) return vec4(0.0);
  float aa = 0.65 / dpr;
  float strokeW = 1.65;
  float R = radius - 1.2;
  float ring = 1.0 - smoothstep(strokeW * 0.5 - aa, strokeW * 0.5 + aa, abs(rad - R));
  float head = fract(time * 0.92);
  float ang = atan(q.x, -q.y) / 6.2831853;
  float behind = fract(head - ang);
  float arc = exp(-behind * 5.2) * ring;
  vec2 hp = vec2(sin(head * 6.2831853), -cos(head * 6.2831853)) * R;
  float hd = length(q - hp);
  float cap = 1.0 - smoothstep(strokeW * 0.65 - aa, strokeW * 0.65 + aa, hd);
  float track = ring * 0.16;
  vec3 hot = mix(tint, vec3(1.0), 0.72);
  vec3 rgb = tint * (track + arc * 0.92) + hot * cap;
  float a = clamp(track + arc * 0.92 + cap, 0.0, 1.0);
  return vec4(min(rgb, vec3(1.0)) * a, a);
}

vec4 shadeMatrix(vec2 p, vec2 center, float radius, float dpr, float time, vec3 tint) {
  float span = radius * 1.42;
  vec2 local = p - (center - vec2(span * 0.5));
  if (local.x < 0.0 || local.y < 0.0 || local.x > span || local.y > span) return vec4(0.0);
  float cell = span / 3.0;
  vec2 ci = clamp(floor(local / cell), vec2(0.0), vec2(2.0));
  vec2 cc = (ci + 0.5) * cell;
  float ph = fract(time * 0.75 - (ci.x + ci.y * 1.4) / 5.2);
  float b = ph < 0.5 ? minJerk(ph * 2.0) : minJerk(2.0 - ph * 2.0);
  float bump = pow(b, 2.0);
  float dotR = cell * mix(0.16, 0.34, bump);
  float d = length(local - cc) - dotR;
  float cov = clamp(0.5 - d * dpr, 0.0, 1.0);
  float lum = mix(0.28, 1.0, bump);
  vec3 rgb = mix(tint, vec3(0.98, 1.0, 0.99), bump * 0.6) * lum;
  float a = cov * lum;
  return vec4(rgb * cov, a);
}

void main() {
  vec2 p = v_uv * u0.xy;
  float dpr = max(u0.z, 1.0);
  float time = u0.w;
  float w = u1.x, h = u1.y, r = u1.z, topY = u1.w;
  float velW = u2.x, velH = u2.y, satGap = u2.z, satR = u2.w;
  vec2 cursor = u3.xy;
  float tone = u3.z;
  float activity = clamp(u3.w, 0.0, 1.3);
  float workStyle = u4.x;
  float sheenPhase = u4.y;
  float clickPulse = u4.z;

  float totalShift = max(0.0, satGap + satR * 2.0) * 0.5;
  vec2 cMain = vec2(u0.x * 0.5 - totalShift, topY + h * 0.5);
  vec2 cSat = vec2(cMain.x + w * 0.5 + satGap + satR, topY + h * 0.5);
  vec2 orbCenter = vec2(cMain.x - w * 0.5 + 16.0, topY + 16.0);

  vec2 blurVec = vec2(velW, velH) * 0.024;
  float blurMag = length(blurVec);
  float d = 0.0;
  float cov = 0.0;
  if (blurMag > 0.6) {
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float accCov = 0.0;
    float midD = 0.0;
    for (int k = 0; k < 9; k++) {
      float f = (float(k) + ign) / 9.0 - 0.5;
      float dk = evalField(p, max(40.0, w + blurVec.x * f), max(24.0, h + blurVec.y * f), r, topY, satGap + blurVec.x * 0.25 * f, satR);
      accCov += clamp(0.5 - dk * dpr, 0.0, 1.0);
      if (k == 4) midD = dk;
    }
    cov = accCov / 9.0;
    d = midD;
  } else {
    d = evalField(p, w, h, r, topY, satGap, satR);
    cov = clamp(0.5 - d * dpr, 0.0, 1.0);
  }

  if (cov <= 0.001) {
    fragColor = vec4(0.0);
    return;
  }

  vec3 tint = vec3(0.34, 0.88, 0.64);
  if (tone > 1.5 && tone < 2.5) {
    tint = vec3(0.36, 0.64, 1.0);
  } else if (tone >= 2.5) {
    tint = vec3(0.98, 0.72, 0.22);
  }

  float hairMask = clamp(1.0 - abs(d * dpr + 0.75), 0.0, 1.0);
  float topFactor = 1.0 - smoothstep(topY, topY + h * 0.5, p.y);
  vec3 rgb = vec3(0.035, 0.036, 0.042) + vec3(topFactor * 0.022);
  float rimAlpha = 0.13 + topFactor * 0.14;

  float dnOrb = length(p - orbCenter) / 48.0;
  float orbRim = exp(-dnOrb * dnOrb * 2.4) * (0.42 + clickPulse * 0.35);
  rgb += mix(vec3(1.0), tint, 0.65) * hairMask * (rimAlpha + orbRim);

  float dnCur = length(p - cursor) / 96.0;
  if (dnCur < 1.4) {
    float curRim = exp(-dnCur * dnCur * 2.5) * 0.55;
    rgb += vec3(0.85, 0.95, 1.0) * hairMask * curRim;
  }

  if (sheenPhase > 0.01 && sheenPhase < 0.99) {
    float sweepX = mix(cMain.x - w * 0.6, cMain.x + w * 0.6, sheenPhase);
    float diag = (p.x - sweepX) + (p.y - topY) * 0.38;
    float ribbon = exp(-(diag * diag) / 280.0) * sin(sheenPhase * 3.14159265);
    rgb += vec3(1.0) * ribbon * (0.04 + hairMask * 0.45);
  }

  vec4 dotCol = shadeStatusDot(p, orbCenter, dpr, time, activity, tint);
  rgb = rgb * (1.0 - dotCol.a) + dotCol.rgb;

  if (satR > 4.0) {
    vec4 ind = vec4(0.0);
    if (floor(workStyle + 0.5) < 0.5) {
      ind = shadeSpinner(p, cSat, satR * 0.56, dpr, time, tint);
    } else {
      ind = shadeMatrix(p, cSat, satR * 0.58, dpr, time, tint);
    }
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
      size: 80,
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
        device.queue.writeBuffer(uniformBuffer, 0, uniforms.buffer, uniforms.byteOffset, 80)
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
    const u4Loc = gl.getUniformLocation(prog, "u4")
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
        gl.uniform4fv(u4Loc, uniforms.subarray(16, 20))
        gl.drawArrays(gl.TRIANGLES, 0, 6)
      },
    }
  } catch {
    return null
  }
}

export class DynamicIslandRig {
  readonly w = new Spring(148, 15.5, 0.64)
  readonly h = new Spring(30, 13.8, 0.60)
  readonly r = new Spring(15, 18, 0.76)
  readonly topY = new Spring(8, 18, 0.74)
  // satGap: negative (-22) means tucked inside the main pill; +7.5 means cleanly separated by 7.5px of air
  readonly satGap = new Spring(-22, 14.5, 0.60)
  readonly satRadius = new Spring(0, 16, 0.64)
  readonly defocus = new Spring(0, 22, 0.80)
  readonly slideY = new Spring(0, 22, 0.76)
  readonly activity = new Spring(0.25, 16, 0.85)
  readonly clickPulse = new Spring(0, 22, 0.72)
  toneMode = 0
  workStyle = 0
  sheenPhase = 1
  private backend: GpuBackend | null = null
  private initializing = false
  private rafId = 0
  private lastTime = 0
  private simTime = 0
  private virtualMode = false
  private readonly uniforms = new Float32Array(20)
  private lastSignature = ""
  private pointerX = -999
  private pointerY = -999
  private lastCursorPressed = false

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

  pulseClick(): void {
    this.clickPulse.v = 12
    this.w.v += 45
    this.startLoop()
  }

  private measureLabelWidth(fallbackText: string): number {
    const labelEl = this.contentEl.querySelector("#__browser_control_label__") as HTMLElement | null
    if (labelEl) {
      const prevWidth = this.contentEl.style.width
      this.contentEl.style.width = "max-content"
      const measured = Math.ceil(labelEl.getBoundingClientRect().width)
      this.contentEl.style.width = prevWidth
      if (measured > 10) {
        return Math.min(340, Math.max(108, measured + 42))
      }
    }
    return Math.min(340, Math.max(116, fallbackText.length * 6.5 + 42))
  }

  configure(options: {
    readonly tone: "active" | "running" | "waiting"
    readonly isTabRequest: boolean
    readonly label: string
    readonly message?: string
    readonly workStyle?: number
  }): void {
    const signature = `${options.tone}:${options.isTabRequest}:${options.label}:${options.message ?? ""}`
    if (signature !== this.lastSignature) {
      if (this.lastSignature !== "") {
        this.defocus.v = 95
        this.slideY.snap(5)
        this.slideY.set(0)
        this.sheenPhase = 0.01
        if (options.tone === "running") {
          this.workStyle = options.workStyle !== undefined ? options.workStyle : (this.workStyle + 1) % 2
        }
      }
      this.lastSignature = signature
    }
    if (options.workStyle !== undefined) {
      this.workStyle = options.workStyle
    }
    const exactWidth = this.measureLabelWidth(options.label)
    if (options.tone === "waiting") {
      const msgLen = (options.message ?? "").length
      const targetW = Math.min(396, Math.max(308, Math.min(msgLen * 6.2 + 72, 384)))
      const targetH = msgLen > 48 ? 108 : 98
      this.w.set(targetW)
      this.h.set(targetH)
      this.r.set(24)
      this.topY.set(10)
      this.satGap.omega = 28
      this.satRadius.omega = 30
      this.satGap.set(-28)
      this.satRadius.set(0)
      this.activity.set(0.95)
      this.toneMode = options.isTabRequest ? 3 : 2
    } else if (options.tone === "running") {
      this.w.set(exactWidth)
      this.h.set(34)
      this.r.set(17)
      this.topY.set(8)
      this.satGap.omega = 15
      this.satRadius.omega = 17
      this.satGap.set(7.5)
      this.satRadius.set(17)
      this.activity.set(1.0)
      this.toneMode = 1
    } else {
      this.w.set(Math.min(exactWidth, 148))
      this.h.set(28)
      this.r.set(14)
      this.topY.set(8)
      this.satGap.omega = 26
      this.satRadius.omega = 28
      this.satGap.set(-28)
      this.satRadius.set(0)
      this.activity.set(0.25)
      this.toneMode = 0
    }
    this.startLoop()
  }

  stepFrame(dt: number): void {
    this.simTime += dt
    if (this.sheenPhase < 1) {
      this.sheenPhase = Math.min(1, this.sheenPhase + dt * 2.1)
    }
    const w = this.w.step(dt)
    const h = this.h.step(dt)
    const r = this.r.step(dt)
    const topY = this.topY.step(dt)
    const satGap = this.satGap.step(dt)
    const satR = this.satRadius.step(dt)
    const defocus = Math.max(0, this.defocus.step(dt))
    const slideY = this.slideY.step(dt)
    const act = this.activity.step(dt)
    const pulse = Math.max(0, this.clickPulse.step(dt))

    const totalShift = Math.max(0, satGap + satR * 2) * 0.5
    const mainCenterX = ISLAND_CANVAS_W * 0.5 - totalShift
    const targetW = Math.max(1, this.w.target)
    const targetH = Math.max(1, this.h.target)
    const scaleX = Math.max(0.35, w / targetW)
    const scaleY = Math.max(0.35, h / targetH)
    const morphDist = Math.hypot(scaleX - 1, scaleY - 1)
    const contentAlpha = Math.max(0, Math.min(1, 1 - morphDist * 1.15))
    const morphBlur = Math.min(5.5, defocus * 0.16 + morphDist * 7.5)
    this.contentEl.style.width = `${targetW.toFixed(1)}px`
    this.contentEl.style.height = `${targetH.toFixed(1)}px`
    this.contentEl.style.left = `${(mainCenterX - targetW * 0.5).toFixed(1)}px`
    this.contentEl.style.top = `${topY.toFixed(1)}px`
    this.contentEl.style.borderRadius = `${r.toFixed(1)}px`
    this.contentEl.style.transformOrigin = "50% 0%"
    this.contentEl.style.transform = `translate3d(0, ${slideY.toFixed(2)}px, 0) scale3d(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)}, 1)`
    this.contentEl.style.opacity = contentAlpha.toFixed(3)
    this.contentEl.style.filter = morphBlur > 0.12 ? `blur(${morphBlur.toFixed(2)}px)` : ""

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
      const pressed = ghost.dataset.pressed === "true"
      if (pressed && !this.lastCursorPressed) {
        this.pulseClick()
      }
      this.lastCursorPressed = pressed
    }

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
      u[8] = this.w.v
      u[9] = this.h.v
      u[10] = satGap
      u[11] = satR
      u[12] = curX
      u[13] = curY
      u[14] = this.toneMode
      u[15] = act
      u[16] = this.workStyle
      u[17] = this.sheenPhase
      u[18] = pulse
      u[19] = 0
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
        this.toneMode >= 1 ||
        this.sheenPhase < 1 ||
        !this.w.resting ||
        !this.h.resting ||
        !this.satGap.resting ||
        !this.satRadius.resting ||
        !this.defocus.resting ||
        !this.slideY.resting ||
        !this.clickPulse.resting
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
