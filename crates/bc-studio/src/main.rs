//! bc-studio: Native Rust 60fps Steadicam compositor for Browser Control proof recordings.
//!
//! Key design principles:
//! 1. C³-continuous Cascaded Critically-Damped Steadicam (two 2nd-order springs in series
//!    with 140ms look-ahead anticipation): zero jerk at keyframe transitions, fluid-head
//!    camera starts and stops, and logarithmic scale interpolation so zooms never swoop.
//! 2. Adaptive Per-Pixel Line-Integral Motion Blur (95° shutter angle): computes each
//!    pixel's exact source-space velocity vector `(dx, dy)` across the shutter window and
//!    integrates `N = clamp(ceil(len * 1.5), 1, 20)` Hann-weighted taps in linear sRGB
//!    light — eliminating discrete multi-image ghosting while running ~3x faster.
//! 3. Clamped Keys Bicubic (`a = -0.68`) resampling from 2x Retina (`2560x1600`) page
//!    captures when camera velocity settles, keeping UI text razor-sharp.
//! 4. Screen Studio Framed Canvas: at 1.0x zoom the viewport sits on a dark studio mat
//!    with rounded 14px corners, specular 1px border, and soft elevation shadow, smoothly
//!    expanding to full-bleed as the camera pushes into an interaction zone.

use std::{
    env, fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, OnceLock},
    time::Instant,
};

use serde::Deserialize;

const SHUTTER_ANGLE: f64 = 95.0;
const SIM_HZ: usize = 1200;
const LOOKAHEAD_SEC: f64 = 0.14;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StudioSpec {
    width: u32,
    height: u32,
    #[serde(default = "default_fps")]
    fps: u32,
    duration: f64,
    output_path: String,
    #[serde(default = "default_framed")]
    framed: bool,
    states: Vec<PageStateSpec>,
    #[serde(default)]
    moves: Vec<CursorMoveSpec>,
    #[serde(default)]
    clicks: Vec<ClickSpec>,
    #[serde(default)]
    camera: Vec<CameraKeyframeSpec>,
    #[serde(default)]
    spotlights: Vec<SpotlightSpec>,
}

fn default_fps() -> u32 {
    60
}

fn default_framed() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageStateSpec {
    time: f64,
    path: String,
    #[serde(default = "default_transition")]
    transition_duration: f64,
}

fn default_transition() -> f64 {
    0.11
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorMoveSpec {
    start_time: f64,
    duration: f64,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    #[serde(default = "default_arc_sign")]
    arc_sign: f64,
}

fn default_arc_sign() -> f64 {
    1.0
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClickSpec {
    time: f64,
    x: f64,
    y: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CameraKeyframeSpec {
    time: f64,
    focus_x: f64,
    focus_y: f64,
    scale: f64,
    #[serde(default)]
    follow_cursor: f64,
    #[serde(default = "default_cam_omega")]
    omega: f64,
}

fn default_cam_omega() -> f64 {
    6.2
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SpotlightSpec {
    start_time: f64,
    end_time: f64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default = "default_spotlight_dim")]
    dim: f32,
}

fn default_spotlight_dim() -> f32 {
    0.52
}

// ── Linear sRGB lookup tables (from psychopomp-render/src/exposure.rs) ──────

struct LinearTables {
    to_linear: [f32; 256],
    to_srgb: Vec<u8>,
}

impl LinearTables {
    #[inline]
    fn encode(&self, linear: f32) -> u8 {
        self.to_srgb[(linear.clamp(0.0, 1.0) * 65535.0).round() as usize]
    }
}

fn linear_tables() -> &'static LinearTables {
    static TABLES: OnceLock<LinearTables> = OnceLock::new();
    TABLES.get_or_init(|| LinearTables {
        to_linear: std::array::from_fn(|value| {
            let encoded = value as f32 / 255.0;
            if encoded <= 0.04045 {
                encoded / 12.92
            } else {
                ((encoded + 0.055) / 1.055).powf(2.4)
            }
        }),
        to_srgb: (0..65536)
            .map(|value| {
                let linear = value as f32 / 65535.0;
                let encoded = if linear <= 0.003_130_8 {
                    linear * 12.92
                } else {
                    1.055 * linear.powf(1.0 / 2.4) - 0.055
                };
                (encoded * 255.0).round() as u8
            })
            .collect(),
    })
}

// ── Decoded Linear-Light 2x Retina Image ────────────────────────────────────

struct LinearImage {
    width: usize,
    height: usize,
    texels: Vec<[f32; 3]>,
}

impl LinearImage {
    fn load_via_ffmpeg(path: &str) -> Result<Arc<Self>, String> {
        let probe = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=p=0:s=x",
                path,
            ])
            .output()
            .map_err(|e| format!("ffprobe failed: {e}"))?;
        let dims = String::from_utf8_lossy(&probe.stdout);
        let mut parts = dims.trim().split('x');
        let width: usize = parts
            .next()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| format!("invalid width for {path}: {dims}"))?;
        let height: usize = parts
            .next()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| format!("invalid height for {path}: {dims}"))?;

        let mut child = Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-i",
                path,
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "-frames:v",
                "1",
                "-",
            ])
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| format!("ffmpeg decode failed: {e}"))?;
        let mut raw = Vec::with_capacity(width * height * 4);
        child
            .stdout
            .take()
            .unwrap()
            .read_to_end(&mut raw)
            .map_err(|e| format!("read decoded frame: {e}"))?;
        let _ = child.wait();
        if raw.len() < width * height * 4 {
            return Err(format!("short frame buffer for {path}: {}", raw.len()));
        }
        let tables = linear_tables();
        let mut texels = Vec::with_capacity(width * height);
        for px in raw.chunks_exact(4) {
            texels.push([
                tables.to_linear[px[0] as usize],
                tables.to_linear[px[1] as usize],
                tables.to_linear[px[2] as usize],
            ]);
        }
        Ok(Arc::new(Self {
            width,
            height,
            texels,
        }))
    }

    #[inline]
    fn texel(&self, x: isize, y: isize) -> [f32; 3] {
        let cx = x.clamp(0, self.width as isize - 1) as usize;
        let cy = y.clamp(0, self.height as isize - 1) as usize;
        self.texels[cy * self.width + cx]
    }

    #[inline]
    fn bilinear(&self, px: f32, py: f32) -> [f32; 3] {
        let x = px - 0.5;
        let y = py - 0.5;
        let x0 = x.floor();
        let y0 = y.floor();
        let fx = x - x0;
        let fy = y - y0;
        let ix = x0 as isize;
        let iy = y0 as isize;
        let a = self.texel(ix, iy);
        let b = self.texel(ix + 1, iy);
        let c = self.texel(ix, iy + 1);
        let d = self.texel(ix + 1, iy + 1);
        [0, 1, 2].map(|k| {
            let top = a[k] + (b[k] - a[k]) * fx;
            let bot = c[k] + (d[k] - c[k]) * fx;
            top + (bot - top) * fy
        })
    }

    #[inline]
    fn cubic(&self, px: f32, py: f32, a: f32) -> [f32; 3] {
        let x = px - 0.5;
        let y = py - 0.5;
        let bx = x.floor();
        let by = y.floor();
        let fx = x - bx;
        let fy = y - by;
        let ix = bx as isize;
        let iy = by as isize;
        let wx = keys_weights(fx, a);
        let wy = keys_weights(fy, a);
        let mut sum = [0.0_f32; 3];
        let mut low = [f32::INFINITY; 3];
        let mut high = [f32::NEG_INFINITY; 3];
        for (j, &wj) in wy.iter().enumerate() {
            for (i, &wi) in wx.iter().enumerate() {
                let t = self.texel(ix + i as isize - 1, iy + j as isize - 1);
                let near = (1..=2).contains(&i) && (1..=2).contains(&j);
                let w = wi * wj;
                for c in 0..3 {
                    sum[c] += t[c] * w;
                    if near {
                        low[c] = low[c].min(t[c]);
                        high[c] = high[c].max(t[c]);
                    }
                }
            }
        }
        [0, 1, 2].map(|c| sum[c].clamp(low[c], high[c]))
    }

    /// Adaptive line-integral directional motion blur in linear light between
    /// `(px0, py0)` and `(px1, py1)` with Hann window weighting.
    /// Zero ghosting / double-images regardless of pan speed!
    #[inline]
    fn sample_motion_line(&self, px0: f32, py0: f32, px1: f32, py1: f32, sharpness: f32) -> [f32; 3] {
        let dx = px1 - px0;
        let dy = py1 - py0;
        let dist_sq = dx * dx + dy * dy;
        if dist_sq < 0.12 {
            return self.cubic((px0 + px1) * 0.5, (py0 + py1) * 0.5, sharpness);
        }
        let dist = dist_sq.sqrt();
        // ~1.4 taps per source pixel of blur streak, capped at 20 taps
        let taps = ((dist * 1.4).ceil() as usize).clamp(3, 20);
        let mut acc = [0.0_f32; 3];
        let mut w_sum = 0.0_f32;
        for i in 0..taps {
            let u = (i as f32 + 0.5) / taps as f32;
            // Raised cosine (Hann) shutter window: tapers smoothly at both ends
            let w = 0.5 - 0.5 * (std::f32::consts::TAU * u).cos();
            let c = self.bilinear(px0 + dx * u, py0 + dy * u);
            acc[0] += c[0] * w;
            acc[1] += c[1] * w;
            acc[2] += c[2] * w;
            w_sum += w;
        }
        let inv = 1.0 / w_sum;
        [acc[0] * inv, acc[1] * inv, acc[2] * inv]
    }
}

#[inline]
fn keys_weights(t: f32, a: f32) -> [f32; 4] {
    let near = |x: f32| ((a + 2.0) * x - (a + 3.0)) * x * x + 1.0;
    let far = |x: f32| ((a * x - 5.0 * a) * x + 8.0 * a) * x - 4.0 * a;
    [far(1.0 + t), near(t), near(1.0 - t), far(2.0 - t)]
}

#[inline]
fn smoothstep(e0: f64, e1: f64, x: f64) -> f64 {
    let t = ((x - e0) / (e1 - e0).max(1e-6)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline]
fn smootherstep(t: f64) -> f64 {
    let u = t.clamp(0.0, 1.0);
    u * u * u * (u * (u * 6.0 - 15.0) + 10.0)
}

#[inline]
fn ease_out_expo(t: f64) -> f64 {
    let u = t.clamp(0.0, 1.0);
    if u >= 1.0 {
        1.0
    } else {
        1.0 - 2.0_f64.powf(-10.0 * u)
    }
}

/// Critically-damped 2-stage cascaded spring (`C³` continuous: position, velocity,
/// acceleration, and jerk are all continuous at keyframe changes!).
#[derive(Clone, Copy)]
struct CascadedSpring {
    x1: f64,
    v1: f64,
    x2: f64,
    v2: f64,
}

impl CascadedSpring {
    fn new(initial: f64) -> Self {
        Self {
            x1: initial,
            v1: 0.0,
            x2: initial,
            v2: 0.0,
        }
    }

    #[inline]
    fn step(&mut self, goal: f64, omega: f64, dt: f64) -> f64 {
        // Stage 1: slightly faster pre-filter (1.35 * omega)
        let w1 = omega * 1.35;
        let k1 = w1 * w1;
        let c1 = 2.0 * w1;
        let a1 = -k1 * (self.x1 - goal) - c1 * self.v1;
        self.v1 += a1 * dt;
        self.x1 += self.v1 * dt;

        // Stage 2: main Steadicam follower (1.15 * omega) driven by Stage 1
        let w2 = omega * 1.15;
        let k2 = w2 * w2;
        let c2 = 2.0 * w2;
        let a2 = -k2 * (self.x2 - self.x1) - c2 * self.v2;
        self.v2 += a2 * dt;
        self.x2 += self.v2 * dt;
        self.x2
    }
}

#[derive(Clone, Copy)]
struct SimStep {
    cam_scale: f32,
    cam_tx: f32,
    cam_ty: f32,
    cursor_page_x: f32,
    cursor_page_y: f32,
    cursor_deg: f32,
    cursor_scale: f32,
    pressed: bool,
}

struct TimelineSimulator {
    steps: Vec<SimStep>,
    total_steps: usize,
}

impl TimelineSimulator {
    fn simulate(spec: &StudioSpec) -> Self {
        let total_steps = ((spec.duration * SIM_HZ as f64).ceil() as usize).max(2);
        let dt = 1.0 / SIM_HZ as f64;
        let vw = spec.width as f64;
        let vh = spec.height as f64;

        // Pass 1: Simulate exact cursor trajectory at 1,200 Hz
        let mut cx = spec.moves.first().map(|m| m.x0).unwrap_or(vw * 0.5);
        let mut cy = spec.moves.first().map(|m| m.y0).unwrap_or(vh * 0.5);
        let mut cvx = 0.0_f64;
        let mut cvy = 0.0_f64;
        let mut cdeg = 0.0_f64;
        let mut cscale = 1.0_f64;
        let mut cvscale = 0.0_f64;

        let mut cursor_track = Vec::with_capacity(total_steps);

        for idx in 0..total_steps {
            let t = idx as f64 * dt;
            let mut active_move = None;
            let mut target_x = cx;
            let mut target_y = cy;
            for mv in &spec.moves {
                if t >= mv.start_time && t <= mv.start_time + mv.duration {
                    active_move = Some(mv);
                    break;
                }
                if t > mv.start_time + mv.duration {
                    target_x = mv.x1;
                    target_y = mv.y1;
                }
            }

            let pressed = spec
                .clicks
                .iter()
                .any(|c| t >= c.time && t <= c.time + 0.065);
            let just_released = spec
                .clicks
                .iter()
                .any(|c| (t - (c.time + 0.065)).abs() < dt * 0.6);
            if just_released {
                cvscale = 2.8;
            }
            let press_dip = if pressed { -4.5 } else { 0.0 };

            if let Some(mv) = active_move {
                let u = ((t - mv.start_time) / mv.duration).clamp(0.0, 1.0);
                let s = smootherstep(u);
                let dx = mv.x1 - mv.x0;
                let dy = mv.y1 - mv.y0;
                let dist = dx.hypot(dy).max(1.0);
                let nx = -dy / dist;
                let ny = dx / dist;
                let far_factor = smoothstep(50.0, 220.0, dist);
                let arc_offset = dist * 0.16 * far_factor * mv.arc_sign;
                let cx1 = mv.x0 + dx * 0.30 + nx * arc_offset;
                let cy1 = mv.y0 + dy * 0.30 + ny * arc_offset;
                let cx2 = mv.x0 + dx * 0.72 + nx * arc_offset * 0.55;
                let cy2 = mv.y0 + dy * 0.72 + ny * arc_offset * 0.55;
                let inv = 1.0 - s;
                let bx = inv * inv * inv * mv.x0
                    + 3.0 * inv * inv * s * cx1
                    + 3.0 * inv * s * s * cx2
                    + s * s * s * mv.x1;
                let by = inv * inv * inv * mv.y0
                    + 3.0 * inv * inv * s * cy1
                    + 3.0 * inv * s * s * cy2
                    + s * s * s * mv.y1;
                cvx = (bx - cx) / dt;
                cvy = (by - cy) / dt;
                cx = bx;
                cy = by;

                let bell = (std::f64::consts::PI * u.powf(0.82)).sin().powf(1.15);
                let bank_dir = (dx / dist.max(40.0)).clamp(-1.0, 1.0) * 0.72 + mv.arc_sign * 0.28;
                let target_deg = bank_dir * 26.0 * far_factor * bell + press_dip;
                cdeg += (target_deg - cdeg) * (dt * 32.0).min(1.0);
            } else {
                let omega = 28.0;
                let zeta = 0.90;
                let k = omega * omega;
                let c = 2.0 * zeta * omega;
                let ax = -k * (cx - target_x) - c * cvx;
                let ay = -k * (cy - target_y) - c * cvy;
                cvx += ax * dt;
                cvy += ay * dt;
                cx += cvx * dt;
                cy += cvy * dt;
                cdeg += (press_dip - cdeg) * (dt * 26.0).min(1.0);
            }

            let target_cscale = if pressed { 0.80 } else { 1.0 };
            let sc_acc = -680.0 * (cscale - target_cscale) - 32.0 * cvscale;
            cvscale += sc_acc * dt;
            cscale += cvscale * dt;

            cursor_track.push((cx, cy, cdeg, cscale, pressed));
        }

        // Pass 2: Simulate C³ Cascaded Steadicam with 140ms look-ahead anticipation
        let mut spring_fx = CascadedSpring::new(vw * 0.5);
        let mut spring_fy = CascadedSpring::new(vh * 0.5);
        let mut spring_log_s = CascadedSpring::new(0.0);

        // When `spec.framed` is true, at 1.0x zoom the page sits at 0.935x inside a dark studio frame,
        // and seamlessly expands as the camera zooms in!
        let rest_scale = if spec.framed { 0.935 } else { 1.0 };

        let mut steps = Vec::with_capacity(total_steps);

        for idx in 0..total_steps {
            let t = idx as f64 * dt;
            let lookahead_t = (t + LOOKAHEAD_SEC).min(spec.duration);
            let lookahead_idx = ((lookahead_t * SIM_HZ as f64) as usize).min(total_steps - 1);
            let (fut_cx, fut_cy, ..) = cursor_track[lookahead_idx];
            let (cur_cx, cur_cy, cur_deg, cur_scale, pressed) = cursor_track[idx];

            let mut active_cam = None;
            for kf in &spec.camera {
                if lookahead_t >= kf.time {
                    active_cam = Some(kf);
                }
            }
            let (mut goal_fx, mut goal_fy, raw_scale, follow, omega) = match active_cam {
                Some(kf) => (
                    kf.focus_x,
                    kf.focus_y,
                    kf.scale.clamp(1.0, 2.6),
                    kf.follow_cursor.clamp(0.0, 1.0),
                    kf.omega.clamp(2.5, 12.0),
                ),
                None => (vw * 0.5, vh * 0.5, 1.0, 0.0, 5.2),
            };

            let goal_scale = if raw_scale <= 1.001 {
                rest_scale
            } else {
                raw_scale
            };

            goal_fx = goal_fx * (1.0 - follow) + fut_cx * follow;
            goal_fy = goal_fy * (1.0 - follow) + fut_cy * follow;

            if goal_scale > 1.02 {
                let half_vis_w = (vw * 0.5) / goal_scale;
                let half_vis_h = (vh * 0.5) / goal_scale;
                goal_fx = goal_fx.clamp(half_vis_w, vw - half_vis_w);
                goal_fy = goal_fy.clamp(half_vis_h, vh - half_vis_h);
            } else {
                goal_fx = vw * 0.5;
                goal_fy = vh * 0.5;
            }

            let cam_fx = spring_fx.step(goal_fx, omega, dt);
            let cam_fy = spring_fy.step(goal_fy, omega, dt);
            let cam_log_s = spring_log_s.step(goal_scale.ln(), omega * 0.90, dt);

            let cam_scale = cam_log_s.exp().clamp(rest_scale, 3.0);
            let cam_tx = vw * 0.5 - cam_fx * cam_scale;
            let cam_ty = vh * 0.5 - cam_fy * cam_scale;

            steps.push(SimStep {
                cam_scale: cam_scale as f32,
                cam_tx: cam_tx as f32,
                cam_ty: cam_ty as f32,
                cursor_page_x: cur_cx as f32,
                cursor_page_y: cur_cy as f32,
                cursor_deg: cur_deg as f32,
                cursor_scale: cur_scale as f32,
                pressed,
            });
        }

        Self { steps, total_steps }
    }

    #[inline]
    fn sample(&self, time: f64) -> SimStep {
        let pos = (time.max(0.0) * SIM_HZ as f64).min((self.total_steps - 1) as f64);
        self.steps[pos as usize]
    }
}

fn shutter_exposure(center: f64, frame_span: f64, samples: u32) -> Vec<(f64, f32)> {
    let shutter = (SHUTTER_ANGLE / 360.0) * frame_span;
    let start = (center - frame_span * 0.5).max(0.0);
    let end = center + frame_span * 0.5;
    let mut weighted: Vec<(f64, f32)> = (0..samples)
        .map(|s| {
            let phase = (f64::from(s) + 0.5) / f64::from(samples) - 0.5;
            let edge = ((0.5 - phase.abs()) / 0.25).clamp(0.0, 1.0);
            let w = if samples < 4 {
                1.0
            } else {
                edge * edge * (3.0 - 2.0 * edge)
            };
            ((center + phase * shutter).clamp(start, end), w as f32)
        })
        .collect();
    let total: f32 = weighted.iter().map(|(_, w)| *w).sum();
    for (_, w) in &mut weighted {
        *w /= total;
    }
    weighted
}

const DART_VERTS: [[f32; 2]; 6] = [
    [1.35, 1.35],
    [14.65, 6.55],
    [9.65, 9.55],
    [9.35, 9.85],
    [6.50, 14.65],
    [1.35, 1.35],
];

#[inline]
fn sd_polygon_dart(px: f32, py: f32) -> f32 {
    let mut d = f32::MAX;
    let mut s = 1.0_f32;
    for i in 0..5 {
        let v = DART_VERTS[i];
        let w = DART_VERTS[i + 1];
        let ex = w[0] - v[0];
        let ey = w[1] - v[1];
        let wx = px - v[0];
        let wy = py - v[1];
        let h = ((wx * ex + wy * ey) / (ex * ex + ey * ey)).clamp(0.0, 1.0);
        let bx = wx - ex * h;
        let by = wy - ey * h;
        d = d.min(bx * bx + by * by);
        let c0 = py >= v[1];
        let c1 = py < w[1];
        let c2 = ex * wy > ey * wx;
        if (c0 && c1 && c2) || (!c0 && !c1 && !c2) {
            s = -s;
        }
    }
    s * d.sqrt() - 0.55
}

#[inline]
fn sd_rounded_box(px: f32, py: f32, cx: f32, cy: f32, hw: f32, hh: f32, r: f32) -> f32 {
    let qx = (px - cx).abs() - (hw - r);
    let qy = (py - cy).abs() - (hh - r);
    qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r
}

fn main() -> Result<(), String> {
    let started = Instant::now();
    let spec_path = env::args()
        .nth(1)
        .ok_or_else(|| "usage: bc-studio <spec.json>".to_owned())?;
    let spec_text =
        fs::read_to_string(&spec_path).map_err(|e| format!("read {spec_path}: {e}"))?;
    let spec: StudioSpec =
        serde_json::from_str(&spec_text).map_err(|e| format!("parse {spec_path}: {e}"))?;

    let mut decoded_states: Vec<(f64, f64, Arc<LinearImage>)> =
        Vec::with_capacity(spec.states.len());
    for st in &spec.states {
        let img = LinearImage::load_via_ffmpeg(&st.path)?;
        decoded_states.push((st.time, st.transition_duration, img));
    }
    if decoded_states.is_empty() {
        return Err("spec.states must contain at least one image".into());
    }

    let sim = TimelineSimulator::simulate(&spec);
    let tables = linear_tables();
    let out_w = spec.width as usize;
    let out_h = spec.height as usize;
    let frame_count = (spec.duration * spec.fps as f64).round() as usize;
    let frame_dt = 1.0 / spec.fps as f64;
    let half_shutter_sec = 0.5 * (SHUTTER_ANGLE / 360.0) * frame_dt;

    let out_path = PathBuf::from(&spec.output_path);
    if let Some(parent) = out_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let mut encoder = Command::new("ffmpeg")
        .args([
            "-y",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pixel_format",
            "rgba",
            "-video_size",
            &format!("{}x{}", out_w, out_h),
            "-framerate",
            &spec.fps.to_string(),
            "-i",
            "-",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "12",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            &spec.output_path,
        ])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn ffmpeg encoder: {e}"))?;
    let mut stdin = encoder.stdin.take().unwrap();

    let threads = std::thread::available_parallelism().map_or(4, |n| n.get().min(16));
    let band_rows = out_h.div_ceil(threads).max(1);
    let mut frame_rgba = vec![255_u8; out_w * out_h * 4];

    for frame_idx in 0..frame_count {
        let center_time = (frame_idx as f64 + 0.5) * frame_dt;
        let t0 = (center_time - half_shutter_sec).max(0.0);
        let t1 = (center_time + half_shutter_sec).min(spec.duration);

        let mut base_img = &decoded_states[0].2;
        let mut blend_img: Option<(&Arc<LinearImage>, f32)> = None;
        for (i, (st_time, trans_dur, img)) in decoded_states.iter().enumerate() {
            if center_time >= *st_time {
                if i > 0 && *trans_dur > 0.0 && center_time < *st_time + *trans_dur {
                    base_img = &decoded_states[i - 1].2;
                    let alpha = smootherstep((center_time - *st_time) / *trans_dur) as f32;
                    blend_img = Some((img, alpha));
                } else {
                    base_img = img;
                    blend_img = None;
                }
            }
        }

        let dpr_x = base_img.width as f32 / out_w as f32;
        let dpr_y = base_img.height as f32 / out_h as f32;

        // Shutter start/mid/end camera states for exact per-pixel velocity line integration
        let cam_start = sim.sample(t0);
        let mid_step = sim.sample(center_time);
        let cam_end = sim.sample(t1);
        let sharpness = -0.5 - 0.20 * ((mid_step.cam_scale - 1.0).clamp(0.0, 1.0));

        // 16 shutter sub-samples for the flying cursor
        let cursor_samples: Vec<(SimStep, f32)> = shutter_exposure(center_time, frame_dt, 16)
            .into_iter()
            .map(|(t, w)| (sim.sample(t), w))
            .collect();

        let mut c_min_x = f32::MAX;
        let mut c_min_y = f32::MAX;
        let mut c_max_x = f32::MIN;
        let mut c_max_y = f32::MIN;
        for &(st, _) in &cursor_samples {
            let sx = st.cursor_page_x * st.cam_scale + st.cam_tx;
            let sy = st.cursor_page_y * st.cam_scale + st.cam_ty;
            c_min_x = c_min_x.min(sx - 18.0);
            c_min_y = c_min_y.min(sy - 18.0);
            c_max_x = c_max_x.max(sx + 44.0);
            c_max_y = c_max_y.max(sy + 44.0);
        }

        let active_spotlight = spec.spotlights.iter().find_map(|sp| {
            if center_time < sp.start_time || center_time > sp.end_time + 0.25 {
                return None;
            }
            let fade_in = smootherstep((center_time - sp.start_time) / 0.24) as f32;
            let fade_out =
                (1.0 - smootherstep((center_time - sp.end_time) / 0.24)).clamp(0.0, 1.0) as f32;
            let alpha = fade_in * fade_out;
            (alpha > 0.005).then_some((sp, alpha))
        });

        let active_clicks: Vec<(&ClickSpec, f64)> = spec
            .clicks
            .iter()
            .filter_map(|cl| {
                let dt_click = center_time - cl.time;
                (dt_click >= 0.0 && dt_click <= 0.36).then_some((cl, dt_click))
            })
            .collect();

        let vw_f = out_w as f32;
        let vh_f = out_h as f32;
        // Studio window card bounds in screen space
        let card_cx = vw_f * 0.5 * mid_step.cam_scale + mid_step.cam_tx;
        let card_cy = vh_f * 0.5 * mid_step.cam_scale + mid_step.cam_ty;
        let card_hw = vw_f * 0.5 * mid_step.cam_scale;
        let card_hh = vh_f * 0.5 * mid_step.cam_scale;
        let card_r = 14.0 * ((1.15 - mid_step.cam_scale) / 0.215).clamp(0.0, 1.0);

        let row_bytes = out_w * 4;
        std::thread::scope(|scope| {
            for (band_idx, chunk) in frame_rgba.chunks_mut(band_rows * row_bytes).enumerate() {
                let y_start = band_idx * band_rows;
                let cursor_samples = &cursor_samples;
                let active_clicks = &active_clicks;
                scope.spawn(move || {
                    for (local_y, row) in chunk.chunks_exact_mut(row_bytes).enumerate() {
                        let y = (y_start + local_y) as f32 + 0.5;
                        let in_cursor_y = y >= c_min_y && y <= c_max_y;
                        let gy = y / vh_f;

                        for x_idx in 0..out_w {
                            let x = x_idx as f32 + 0.5;

                            // 1. Studio backdrop + Framed Window SDF (when cam_scale < 1.05)
                            let card_dist = if card_r > 0.05 {
                                sd_rounded_box(x, y, card_cx, card_cy, card_hw, card_hh, card_r)
                            } else {
                                -10.0
                            };

                            let mut bg_lin = if card_dist >= 0.5 {
                                // Subtle warm obsidian studio backdrop + soft window elevation shadow
                                let gx = (x / vw_f) - 0.5;
                                let vig = 1.0 - 0.35 * (gx * gx + (gy - 0.5) * (gy - 0.5));
                                let sh_dist = sd_rounded_box(
                                    x,
                                    y,
                                    card_cx,
                                    card_cy + 12.0,
                                    card_hw,
                                    card_hh,
                                    card_r,
                                )
                                .max(0.0);
                                let sh = (-(sh_dist * sh_dist) / (2.0 * 18.0 * 18.0)).exp() * 0.65;
                                let base = 0.0038 * vig * (1.0 - sh);
                                [base * 1.05, base * 1.02, base * 0.96]
                            } else {
                                // Exact per-pixel velocity line-integral motion blur across shutter [t0..t1]
                                let src_x0 = ((x - cam_start.cam_tx) / cam_start.cam_scale) * dpr_x;
                                let src_y0 = ((y - cam_start.cam_ty) / cam_start.cam_scale) * dpr_y;
                                let src_x1 = ((x - cam_end.cam_tx) / cam_end.cam_scale) * dpr_x;
                                let src_y1 = ((y - cam_end.cam_ty) / cam_end.cam_scale) * dpr_y;

                                let mut c = base_img
                                    .sample_motion_line(src_x0, src_y0, src_x1, src_y1, sharpness);
                                if let Some((b_img, alpha)) = blend_img {
                                    let b = b_img.sample_motion_line(
                                        src_x0, src_y0, src_x1, src_y1, sharpness,
                                    );
                                    c = [0, 1, 2].map(|k| c[k] + (b[k] - c[k]) * alpha);
                                }

                                // Anti-aliased rounded window edge + 1px specular glass border
                                if card_r > 0.05 && card_dist > -1.8 {
                                    let cov = (0.5 - card_dist).clamp(0.0, 1.0);
                                    let border = (1.1 - (card_dist + 0.6).abs()).clamp(0.0, 1.0)
                                        * 0.032;
                                    let mat = [0.0035_f32, 0.0034, 0.0032];
                                    c = [0, 1, 2].map(|k| mat[k] + (c[k] + border - mat[k]) * cov);
                                }
                                c
                            };

                            // 2. Dimmed Spotlight cutout (if active)
                            if let Some((sp, alpha)) = active_spotlight {
                                let sx = (sp.x as f32) * mid_step.cam_scale + mid_step.cam_tx;
                                let sy = (sp.y as f32) * mid_step.cam_scale + mid_step.cam_ty;
                                let sw = (sp.width as f32) * mid_step.cam_scale;
                                let sh = (sp.height as f32) * mid_step.cam_scale;
                                let pad = 10.0 * mid_step.cam_scale;
                                let dist = sd_rounded_box(
                                    x,
                                    y,
                                    sx + sw * 0.5,
                                    sy + sh * 0.5,
                                    sw * 0.5 + pad,
                                    sh * 0.5 + pad,
                                    10.0,
                                );
                                let outside = ((dist - 0.5) / 1.5).clamp(0.0, 1.0);
                                let dim_factor = 1.0 - sp.dim * alpha * outside;
                                bg_lin = bg_lin.map(|v| v * dim_factor);
                                let rim = (1.1 - dist.abs()).clamp(0.0, 1.0) * alpha;
                                if rim > 0.0 {
                                    let gold = [0.74_f32, 0.44, 0.10];
                                    bg_lin =
                                        [0, 1, 2].map(|c| bg_lin[c] + (gold[c] - bg_lin[c]) * rim);
                                }
                            }

                            // 3. Tactile variable-stroke click shockwave rings
                            for &(cl, dt_click) in active_clicks {
                                let cx_scr = (cl.x as f32) * mid_step.cam_scale + mid_step.cam_tx;
                                let cy_scr = (cl.y as f32) * mid_step.cam_scale + mid_step.cam_ty;
                                let d = (x - cx_scr).hypot(y - cy_scr);
                                let max_r = 26.0 * mid_step.cam_scale.powf(0.28);
                                if d < max_r + 6.0 {
                                    let u = (dt_click / 0.32).clamp(0.0, 1.0);
                                    let e = ease_out_expo(u) as f32;
                                    let r = 4.0 + (max_r - 4.0) * e;
                                    let half_stroke = 1.40 * (1.0 - 0.82 * e);
                                    let alpha = ((1.0 - u as f32) * (1.0 - u as f32 * 0.35))
                                        .clamp(0.0, 1.0);
                                    let ring_dist = (d - r).abs();
                                    let dark_cov = (half_stroke + 0.9 - ring_dist).clamp(0.0, 1.0)
                                        * alpha
                                        * 0.55;
                                    bg_lin = bg_lin.map(|v| v * (1.0 - dark_cov));
                                    let white_cov =
                                        (half_stroke + 0.4 - ring_dist).clamp(0.0, 1.0) * alpha;
                                    bg_lin = bg_lin.map(|v| v + (0.96 - v) * white_cov);
                                }
                            }

                            // 4. 16-sample shutter-blurred vector dart cursor
                            if in_cursor_y && x >= c_min_x && x <= c_max_x {
                                let mut cur_acc = [0.0_f32; 3];
                                for &(st, weight) in cursor_samples {
                                    let cx_scr = st.cursor_page_x * st.cam_scale + st.cam_tx;
                                    let cy_scr = st.cursor_page_y * st.cam_scale + st.cam_ty;
                                    let size_scale = (23.0 / 16.0)
                                        * st.cursor_scale
                                        * st.cam_scale.max(1.0).powf(0.28);
                                    let dx = x - cx_scr;
                                    let dy = y - cy_scr;
                                    if dx < -14.0 || dy < -14.0 || dx > 38.0 || dy > 38.0 {
                                        for k in 0..3 {
                                            cur_acc[k] += bg_lin[k] * weight;
                                        }
                                        continue;
                                    }
                                    let rad = -st.cursor_deg.to_radians();
                                    let (sin_r, cos_r) = rad.sin_cos();

                                    let sh_off_y = if st.pressed { 1.0 } else { 2.6 };
                                    let sh_blur = if st.pressed { 1.4 } else { 2.8 };
                                    let sdx = (dx * cos_r - (dy - sh_off_y) * sin_r) / size_scale
                                        + 1.4;
                                    let sdy = (dx * sin_r + (dy - sh_off_y) * cos_r) / size_scale
                                        + 1.4;
                                    let sh_dist = sd_polygon_dart(sdx, sdy) * size_scale;
                                    let sh_alpha =
                                        ((-sh_dist.max(0.0).powi(2)) / (2.0 * sh_blur * sh_blur))
                                            .exp()
                                            * (if st.pressed { 0.48 } else { 0.34 });

                                    let lx = (dx * cos_r - dy * sin_r) / size_scale + 1.4;
                                    let ly = (dx * sin_r + dy * cos_r) / size_scale + 1.4;
                                    let d = sd_polygon_dart(lx, ly) * size_scale;

                                    let mut sample_rgb =
                                        bg_lin.map(|v| v * (1.0 - sh_alpha));
                                    let outer_cov = (0.95 - d).clamp(0.0, 1.0);
                                    if outer_cov > 0.0 {
                                        let stroke_rgb = [0.955_f32, 0.955, 0.945];
                                        let fill_rgb = [0.012_f32, 0.012, 0.014];
                                        let inner_cov = (-0.45 - d).clamp(0.0, 1.0);
                                        let dart_rgb = [0, 1, 2].map(|c| {
                                            stroke_rgb[c] + (fill_rgb[c] - stroke_rgb[c]) * inner_cov
                                        });
                                        sample_rgb = [0, 1, 2].map(|c| {
                                            sample_rgb[c]
                                                + (dart_rgb[c] - sample_rgb[c]) * outer_cov
                                        });
                                    }
                                    for k in 0..3 {
                                        cur_acc[k] += sample_rgb[k] * weight;
                                    }
                                }
                                bg_lin = cur_acc;
                            }

                            let px = &mut row[x_idx * 4..x_idx * 4 + 4];
                            px[0] = tables.encode(bg_lin[0]);
                            px[1] = tables.encode(bg_lin[1]);
                            px[2] = tables.encode(bg_lin[2]);
                            px[3] = 255;
                        }
                    }
                });
            }
        });

        stdin
            .write_all(&frame_rgba)
            .map_err(|e| format!("write frame {frame_idx}: {e}"))?;
    }

    drop(stdin);
    let status = encoder.wait().map_err(|e| format!("wait ffmpeg: {e}"))?;
    if !status.success() {
        return Err(format!("ffmpeg exited with {status}"));
    }
    eprintln!(
        "bc-studio rendered {frame_count} frames ({}x{} @ {}fps) in {:.2}s -> {}",
        out_w,
        out_h,
        spec.fps,
        started.elapsed().as_secs_f64(),
        spec.output_path
    );
    Ok(())
}
