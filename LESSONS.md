# Lessons from FrameCraft

FrameCraft (`samsam32118/videoaftereffects`) is an earlier browser-based editor by the same owner.
Michelangelo borrows its ideas, never its code. This file records every borrowed idea and every
FrameCraft mistake Michelangelo is designed to avoid, each with where it was verified.

Sources read (2026-10-03): `docs/AGENT-PLATFORM-PLAN.md` and `docs/spikes/render-cloud.md` (branch
`docs/agent-platform-plan`); `PLAN.md`, `src/engine/types.ts`, `docs/AGENT-API-CONVENTIONS.md`,
`docs/PLUGINS.md`, `public/agent.md` (main).

## Lessons verified in this session

| # | FrameCraft lesson (claimed) | Verified here? | What Michelangelo does |
|---|---|---|---|
| V1 | Without a GPU, browser WebGL runs on the CPU (SwiftShader); ~85 % of a 1080×1920 frame's cost, 6.4× real time | Not re-run in the browser; the opposite side measured: **Skia composites a comparable 1080×1920 frame in 11 ms** (vs FrameCraft's 210–270 ms) | Skia from Node, no browser (DESIGN §7) |
| V2 | Native x264 `veryfast` encodes 1080×1920 at ~65 fps on 4 vCPU | Consistent: Skia + RGBA pipe + x264 `veryfast` ran end to end at 39 ms/frame (1.16× real time) on one process | Encode with native ffmpeg from raw frames |
| V3 | Project files reached 3,000–20,000 lines, random ids, cached thumbnails inside | Yes, as documented in the plan's §1.3 table (`muse`: 214 clips, 20,643 lines, 100 KB of cached thumbnails/waveforms); `types.ts` confirms `Transform` has 8 required keys and every clip carries `effects: []`, `blendMode`, etc. | One entity per line, defaults omitted, caches outside the file, readable ids (DESIGN §4) |
| V4 | Agents need blocking commands with an estimate, images, sound as text, no browser unless pixels | Matches this session's tools: 2 min default shell timeout, image reading, no audio/video | `look`, estimates, sound report (DESIGN §8) |

## Borrowed ideas

| Idea | From | In Michelangelo |
|---|---|---|
| One entity per line, id first, stable key order, readable ids, defaults omitted, no derived data | AGENT-PLATFORM-PLAN R1/R2, D6 | File format, DESIGN §4 |
| `check` names the line and the fix; hand edits are accepted, not forbidden | R2 | DESIGN §4.3 |
| One API, three doors (CLI, SDK, file) | R3 | DESIGN §6 |
| Exit codes 0/1/2 with the fix in the message | R5 | DESIGN §10 |
| Estimate on the first line of long commands | R5 | `render`, DESIGN §7.1 |
| Contact sheet + zoomed crops ≤ 1568 px, sound as text | R6 | `look`, DESIGN §8 |
| Pinned downloads by Node through the proxy into a cache | R7 | ffmpeg acquisition, DESIGN §7.3 |
| `show` outline so an agent never reads a huge file | Phase 1 `show` | DESIGN §6.1 |
| Plugins load only when config names them (cloned-repo attack surface) | D7 | DESIGN §9.2 |
| Semver plugin API; minor = additive; `incompatible` plugins never run | PLUGINS.md "Versioning" | DESIGN §9.2 |
| Stable string error codes with hint and did-you-mean; unknown keys are errors, never dropped | AGENT-API-CONVENTIONS §1, §3 | DESIGN §4.1, §10 |
| Every mutation dry-runnable faithfully, or not offered as a command | AGENT-API-CONVENTIONS §4 (`NOT_SIMULATABLE`) | Render/import are verbs, not commands (DESIGN §5) |
| Every docs code example executed by the test suite | `agent-docs-sync.spec.ts` | DESIGN §15, docs tests |
| A split never restarts an animation (animation clock offset on split) | `ClipBase.animOffset` | `split` semantics, DESIGN §5.2 |
| QA findings come with a fix command; fixes computed from what is drawn | AGENT-API-CONVENTIONS §7, I2.3 | `look` findings (DESIGN §8); overlap checks use rendered alpha |
| Platform safe zones (Shorts / TikTok / Reels) and loudness targets per platform | `Project.platform` | QA checks, `audio.normalize` |
| Lossy audio loudness checked after the codec | AGENT-API-CONVENTIONS §8 | Render verification measures the encoded output |
| Eval: regression set + held-out set; record failed edits, timeouts, bytes read | PLAN "Next steps", AGENT-PLATFORM-PLAN Phase 4 | DESIGN §11 |
| FSL-1.1-ALv2 licence; GPL ffmpeg kept outside the package | D1, D2 | Licence; ffmpeg fetched at run time, never bundled |
| Render split by frame range, audio rendered once | Phase 2 | Parallel segments, DESIGN §7.1 |

## FrameCraft mistakes avoided

| Mistake | Evidence | Michelangelo's rule |
|---|---|---|
| Floating-point seconds as the internal time unit | `types.ts`: "Time is always expressed in SECONDS (float)"; keyframe `t` in seconds | Integer frames inside, seconds only at the edges (DESIGN §3) |
| A browser in the core: every render and many checks needed Chromium | PLAN §2 (three.js, WebCodecs, ffmpeg.wasm) | No browser; Skia + native ffmpeg (DESIGN §7) |
| Surface-area sprawl: 238 tools, a 1,186-line agent guide, a 58.6 KB compact tool list | PLAN status; `public/agent.md` length | 9 verbs, ~60 core commands, SKILL.md < 3k tokens (DESIGN R7) |
| Legacy aliases everywhere (`path`/`propPath`, `mute`/`muted`, `effectId`/`id`, `ducking.amountDb`/`amount`) each needing a rename note | AGENT-API-CONVENTIONS §1, agent.md §2 | One name per concept, no aliases; a wrong name is an error with did-you-mean |
| Three overlapping orderings (track order, group `layer`, keyframable `zIndex`) | `types.ts` ClipBase | Track order is the only stacking order |
| Required fields with defaults stored on every entity (8-key `Transform`, `effects: []`, `blendMode`) | `types.ts` | Defaults omitted on write, filled from the schema on read |
| Cached thumbnails and waveforms inside the project file | Plan §1.3: 100 KB of 306 KB in `muse` | Caches in `.mgl/cache/` keyed by content hash |
| Random ids (`clip_w21323x9iv0s`) | Plan §1.3 | Readable ids, kept when given |
| Big objects embedded in the project (a `.cube` LUT as `data: string` inside `ClipGrade.lut`) | `types.ts` `GradeLut.data` | LUTs, fonts and subtitles are assets referenced by path |
| Results and lists that change shape with size (array vs page object at 32 KB) | AGENT-API-CONVENTIONS §2 | One shape per output; text output capped, details written to files |
| A GPL ffmpeg core bundled into the app's `dist/` | AGENT-PLATFORM-PLAN D2 | ffmpeg fetched at run time; a CI check that no GPL file is in the npm tarball |
| Clip-local keyframe times past the clip end silently never play | agent.md "Units" | `check` reports keyframes outside the clip as a warning with the line |
| Accreted optional fields for every feature on one `ClipBase` interface (grade, cornerPin, reflection, qa, role, syncTo, ...) | `types.ts` | Features beyond the core are effects/generators with typed params (plugins), not new top-level clip fields |
| Built-ins and plugins on different seams early on (iteration 2 `install(ctx)` wrapped later into plugins) | PLUGINS.md | Core effects use only the public plugin API from day one, enforced by a test |
