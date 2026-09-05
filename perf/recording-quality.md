# Recording quality

Goal: preserve readable UI pixels and smooth actual motion, not merely label a
small or repeated image 720p/30fps. Do not restart the shared relay for experiments.

## Benchmark

```sh
pnpm bench:recording-quality --browser <Chromium-executable> --out <fresh-directory>
pnpm bench:recording-quality --browser <Chromium-executable> --backing-surface --verify --out <fresh-directory>
pnpm bench:recording-quality --browser <Chromium-executable> --width 1920 --height 1080 --dpr 1 --verify --out <fresh-directory>
```

Requires ffmpeg and ffprobe. `--verify` requires text SSIM ≥ 0.98, at least 45
actual motion changes/sec, native output dimensions, and no dropped frames in
every measured run. `--format webm` checks the alternate encoder.

For extension evidence, create a **disposable** Browser Control session with one
blank owned page, then pass `--session <id>` instead of `--browser`. This replaces
that page's content and emulation. The source recorder runs in the benchmark
process; only CDP commands/events cross the installed relay. It does not replace
the installed recorder, restart the relay, or touch other sessions. Delete the
disposable session afterward. This harness uses the default local relay port.

Runs the production `RecordingRelay` against an isolated Chromium CDP session and
real ffmpeg. One warmup, seven measured 2.2-second recordings. Primary metric:
median text-region SSIM versus the same browser's native PNG. Guardrails: actual
moving-bar position changes per decoded second, output dimensions, dropped source
frames, duration and file size. Normalization for scoring is not a delivery fix.

Repeat with 1280×720 and 1920×1080 CSS viewports and DPR 1/2. A direct-CDP browser
run does not certify the extension transport; verify the winner through a dedicated
Browser Control session before calling the original failure fixed.

## Reference

Vercel `vercel-labs/agent-browser` cloned read-only at
`4a98df79bd232fcde5ca3a4a48e1337b8108b160`. Its Rust recorder requests JPEG80,
does not cap screencast dimensions, derives ffmpeg dimensions from image input,
and defaults to30fps with a60fps ceiling. It uses a separate capture session.
Its five-second gap truncation is NOT a behavior to copy: Browser Control must
retain the actual recording timeline. Source comparison is not an executed
agent-browser quality score.

## Baseline / experiments

Production source starts at3019ad9; installed0.6.0 is
a separate artifact. Known user repro: 1280×720 output contains640×360 page plus
padding; a later screenshot-loop workaround retains pixels but only about10fps.
Organizer bug: ba8d0274. Keep raw artifacts outside the repository.

- Initial broad-region SSIM was diluted by whitespace; narrowed the primary score
  to a fixed800×220 text/button region and reran the baseline before source edits.
- 1080p baseline (1warmup+7): textSSIM **0.960825**, distinct motion25fps,
  output1280×720, median24530bytes/2.2s. The cap destroys requested detail.
- **Keep native viewport dimensions:** SSIM **0.984925**, motion25fps, zero drops,
  output1920×1080, median35436bytes. Existing frame-ack/timeline test red then green
  with native-size expectations. This is not yet the original padding defect fix.
- Live-extension benchmark initially used a second Playwright CDPSession and
  received no compositor events (only stop-time screenshot fallback). Those runs
  are invalid motion evidence. A dedicated raw CDP client with one target alias
  receives real events: roughly60sourcefps/25encodedfps at1280×720. It uses only
  the benchmark-owned session, never restarts the shared relay.
- Next hypothesis: JPEG95 improves small-text fidelity beyond JPEG80 without
  reducing distinct motion rate. Only the quality constant changes in this round.
- **Keep JPEG95 candidate:**1080p SSIM0.992925 (vs0.984925),25distinctfps,
  zero drops, median32512bytes (vs35436). Cleaner source JPEGs also compressed
  better in this synthetic MP4. Next test JPEG100 for remaining headroom.
- Executed released Agent Browser0.36.0 on the same1280fixture: seven runs,
  median textSSIM about0.9845 and10distinctfps. Its stop result has no captured
  frame counter. This differs from cloned main's30/60fps screencast implementation;
  do not misrepresent the release binary as execution of the cloned source.
- **Keep JPEG100:** SSIM0.993832,25distinctfps, median31982bytes/1080p clip.
- **Keep uncapped screencast + crop at native scale:** reproduced original bug
  with a2560×1273 backing surface and1280×720 emulated viewport using
  `dontSetVisibleSize:true`. Before SSIM0.861510 and visibly half-sized content;
  after seven measured runs SSIM0.993832,25distinctfps, full-size content.
  The pad must round UP to even dimensions before crop: odd1273height otherwise
  makes ffmpeg fail `Padded dimensions cannot be smaller than input dimensions`.
  Preserved encoder stderr on pipe failure so this is not hidden as stream-destroyed.
- Next hypothesis:60fps retains the source compositor's real motion without
  reducing text quality. Test at1080p and through the existing extension on an
  owned synthetic tab; no shared-runtime replacement.

## Retina correction and final validation

Uncapped capture alone is insufficient. The live Retina path returned two image
pixels per CSS surface pixel; cropping directly cut off half the content
(SSIM 0.830768). **Discard that intermediate implementation.** Normalize the
JPEG down to the first frame's `metadata.deviceWidth`, preserving aspect ratio,
then pad/crop to the starting CSS viewport. Never upscale a smaller source.

This requires the production encoder to receive the first frame's surface width.
Its acquisition is lazy and cancellation waits for an in-progress acquisition;
a bounded start-time `ffmpeg -version` probe preserves missing-dependency errors.
Normalize aspect ratio with `-1`, not `-2`: even-rounding at the scale stage
stretches an odd-height surface. Round up only when padding, before final crop.
Viewport/emulation must remain fixed during a recording.

**Keep 60 fps:** controlled motion rises from 25 to roughly 59 distinct frames/sec.
Text SSIM changes from 0.993832 at 25 fps to approximately 0.99332 at 60 fps;
the small compression difference buys substantially smoother motion. MP4 median
size rises from about 32 KB to 38 KB for this 2.2-second 1080p fixture. Real sites
will cost more; high-DPI source transport remains a throughput limit.

Final seven-run medians (one warmup each, after excluding the initial static
position from the motion-change count):

| Case | Text SSIM | Distinct motion/sec | Output | Drops |
| --- | ---: | ---: | --- | ---: |
| Isolated, odd backing surface, emulated viewport | 0.993319 | 59.55 | 1280×720 | 0 |
| Live extension, Retina + odd backing surface | 0.988932 | 51.36 | 1280×720 | 0 |
| Isolated 1080p, DPR 1 | 0.993321 | 58.65 | 1920×1080 | 0 |
| Isolated 1080p, WebM | 0.995020 | 58.64 | 1920×1080 | 0 |

The live stress case ranged from 47.82–54.55 actual motion changes/sec, not a
guaranteed 60 distinct frames. All four cases passed `--verify`; encoded native
MP4 frames were visually inspected. Isolated Chromium was 151.0.7922.34, Playwright
1.62.1. The shared extension/relay remained on their existing installation.

Artifacts are retained under the session temp directory, prefixes
`bc-final-odd-surface`, `bc-final-live-retina`, and `bc-final-1080-dpr1`.
The original bad artifacts and rejected intermediate runs remain for diagnosis.
Unit suite: 705 tests / 54 files, including frame acknowledgements, monotonic
timeline, cancellation, first-frame surface metadata, native dimensions, and
default/explicit/capped frame rates. No full browser smoke-set claim.

Final gates: `pnpm typecheck`, `pnpm check:locals`, `pnpm check:unused`,
`bun run test`, and `pnpm build:cli --outdir <external-directory>` passed.
The benchmark-owned browser session was deleted; the unrelated local UI fixture
was retained. The recording guidance was synced into the canonical dotfiles
skill without overwriting its unrelated, newer workflow sections.

No package has been published or selected, and no shared relay was restarted.
The source correction is verified; installed-runtime rollout remains separate.

## Follow-up: visual diffs, receipts, and strict frame rates

Implemented the three approved follow-ups without replacing the installed tool:

- `screenshotDiff` is a session-page execute helper using PNGJS and Pixelmatch.
  Same CSS scale, no implicit resizing, bounded PNG decoding, exclusive private
  output files. A real Chromium/DPR-2 fixture compared equal with zero changes;
  changing one button's colors highlighted 9,394 pixels (1.529% of 960×640).
  The generated diff was visually inspected. Sandbox tests also verify that the
  global is bound correctly and the PNG is extracted as execute media.
- CDP stop/status `quality` receipts and the existing sidecar share one source
  of counters. A real 30 fps capture returned 112 compositor events, 36 retained
  images, 76 coalesced events, and zero drops. The schema-decoded receipt matched
  every sidecar quality field. These are not distinct-motion measurements.
  The stop-time screenshot fallback has a separate flag and visible warning.
- Frame rates must be integers in 1..60 at CLI, HTTP schema, and recorder
  boundaries. A standalone installed CLI rejected 120 fps before allocating a
  recording; no output file was created. Explicit rates are never clamped.

Final validation: 740 tests / 56 files; typecheck, locals, Knip, frozen install,
and standalone `runtime:prepare` passed. Packed contents were inspected; the only
new lockfile packages are Pixelmatch, PNGJS, and PNGJS types. An incidental Vite
transitive-resolution change was removed before final validation.

Private proof: `bc-three-proof/{before.png,after.png,diff.png,evidence.json}`.
Final candidate: `bc-visual-final-runtime`; archive in
`bc-visual-final-stage/artifacts`. Candidate prepared, **not selected or published**.
No shared relay restart, extension reload, or full browser smoke-set claim.
