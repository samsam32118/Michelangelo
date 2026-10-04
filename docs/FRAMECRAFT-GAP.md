# FrameCraft → Michelangelo: functional gap analysis

Status: 2026-10-04. Scope: what FrameCraft (`/home/user/videoAftereffects`, main, plus
`docs/AGENT-PLATFORM-PLAN.md` on `docs/agent-platform-plan`) can do that Michelangelo cannot, judged by the
north star (DESIGN §17): **total cost per high-quality video** (tokens/$ + wall time) for an AI coding agent
in a CPU-only container. Concepts only; no FrameCraft code is reused (LESSONS.md).

Sources: FrameCraft `PLAN.md`, `public/agent.md`, `docs/API.md`, `docs/PLUGINS.md`, `src/engine/types.ts`,
catalogues under `src/library`, `src/render`, `src/sound`, `src/motion`, `src/agent`, `src/models`,
`src/three3d`. Michelangelo `DESIGN.md`, `REMAINING.md`, `SKILL.md`, `docs/reference/*`, the live
`builtinRegistry()` and `mgl docs commands`, `bench/results/2026-10-04T08-02.md`, `evals/HISTORY.md`,
`evals/results/m4-final/main/summary.md`.

## 0. Catalogue counts (measured)

| Catalogue | FrameCraft | Michelangelo |
|---|---|---|
| Templates | 66 (titles 15, intros 8, lower thirds 8, backgrounds 8, social 7, elements 7, CTAs 6, outros 4, starters 3) | 11 (intro, lower-third, cta, title, end-card, progress-bar, quote, listicle-item, bars-and-tone, slate, countdown) |
| Video effects | 24 (incl. glitch, film grain, zoom/directional blur, duotone, posterize, 3 cinematic looks, chroma key) | 17 (blur, glow, shadow, vignette, chroma-key, color, lut, denoise, sharpen, grain, pixelate, stroke, mirror, invert, rgb-split, letterbox, legalize) |
| Audio effects | 12 + "Voice Enhance" chain | 11 (highpass, lowpass, eq, dehum, denoise-audio, compressor, limiter, gate, deesser, voice, reverb) |
| Transitions | 23 fixed-direction types (crossfade, dips, 4 wipes, 4 slides, 2 pushes, zoom in/out, spin, blur, circle/diamond reveal, glitch, whip pan, light leak, pixelize) | 9 parametric (crossfade, dip, wipe, slide, push, zoom, blur, spin, flash) ≈ 16 of FC's 23 looks |
| Generators / backgrounds | 8 animated background templates (aurora, gradient flow, particles …) | 12 (gradient, noise, particles, progress-bar, counter, checker, pattern, waveform, spectrum, timecode, smpte-bars, countdown-leader) |
| Text animators | 14 per-unit (char/word/line) + stepped reveal | 12 (by char/word) |
| Caption looks | 7 presets + 9 named styles (hormozi, mrbeast, karaoke, boxed, bounce, neon, word-by-word …) | 10 styles total, 3 caption-specific (caption, karaoke, pop, boxed) |
| Motion presets (any layer, in/out/emphasis/loop) | 49 (pop, punchIn, whip, shake, wiggle, float, breathe, kenBurns, cameraShake …) with stagger and group pivots | 0 (keyframes by hand, `clip.punch-in`) |
| SFX | ~73 procedural, seedable recipes (whoosh, riser, impact, pop, glitch …) | 0 |
| Music | procedural bed: 10 genres × 13 moods, BPM/key/intensity, stems; MusicGen (opt-in) | 0 |
| 3D | 10 three.js presets (title, globe, device, bars, tunnel, terrain, blob, icon, primitive, glTF model) | 0 |
| AI models | whisper-tiny/base (word timings), kokoro-82m + MMS TTS, musicgen-small | 0 (flite only as an eval fixture) |
| Agent recipes | 4 (shortFromScript with 5 styles, listicle, podcastClip, autoCaptions) + `fc.start` | 0 one-call recipes; 9 documented multi-step recipes (`mgl docs recipes`) |
| QA rules | ~29, auto-fix with verification and `qaFixAll` convergence | 20, each finding prints a `fix:` command; nothing applies them |
| Fonts | 14 families | 4 (Anton, Inter, JetBrains Mono, Noto Sans) |
| Surface | 238 tools, 58.6 KB compact tool list, 1,186-line guide (83 KB) + 310 KB API.md | 70 commands, 9 verbs, SKILL.md 186 lines (10.5 KB) |
| **Library items total** | **~130 in the PLAN's count; ≈ 300 counting motion presets, SFX and music** | **~100 (28 fx + 9 transitions + 12 generators + 11 templates + 10 styles + 12 text animations + 20 checks)** |

## 1. Feature matrix by area

Impact = effect of the gap on cost and quality of a typical high-quality Short/YouTube video made by an agent
(H/M/L). Where = **lib** (solve in Michelangelo) or **agent** (leave to the agent / out of scope).

| Area | FrameCraft has | Michelangelo has | Gap | Impact | Where |
|---|---|---|---|---|---|
| Editing | trim, split, ripple, move, speed + speed-ramp presets, freeze, groups, parenting, stabilize, proxies, point tracking, corner pin | trim, split, ripple, slip, slide, roll, speed + time-remap, freeze, link groups, nested comps, parenting, punch-in, layout.grid, reframe with subject tracking | stabilize, corner pin | L | lib (ffmpeg `vidstab`/`perspective` as effects) |
| Audio mixing | buses, ducking, LUFS targets, true-peak limiter, meters, silence removal, beat/onset analysis | buses, ducking (±0.4 dB), two-pass loudness, stems, cut-silences, marker.beats, onsets/tempo in `look` | none material | – | – |
| Sound design | 73 SFX, auto-SFX on motion/cuts (sync-locked), music beds, audio-reactive links | none | SFX library, auto-SFX, music bed, audio-reactive properties | **H** (music, SFX) / M (reactive) | lib |
| Voice | TTS (kokoro, MMS), mic punch-in recorder | none (user must supply `vo.wav`) | TTS voice-over | **H** for script-only briefs | lib (provider point + CPU default) |
| Transcription | Whisper word timings → captions, filler/silence jump cuts | `captions.from-text` timed by silence detection only; VTT word times on import | speech-to-word timings | **H** (caption sync quality on every voiced video) | lib (provider point + CPU default) |
| Text & motion | 14 text animators, 49 motion presets with stagger/loops, custom bezier, spatial paths, expressions (`wiggle`, `loopOut`, `audio.beat`), motion blur, Lottie | 12 text animations, keyframes with CSS/Penner/bezier easing, parenting, masks, trim paths | motion presets for any layer, ambient loops, expressions, motion blur, spatial bezier paths, Lottie | **H** (presets) / M (blur, Lottie) / L (expressions) | lib |
| Captions | SRT/VTT, word karaoke, 9 viral styles, keyword stickers/emoji | SRT/VTT import+export, word karaoke, cue editing, 3 caption styles | named viral styles (hormozi/mrbeast/bounce/neon), keyword emphasis | M | lib |
| Effects/transitions/grading | 24 fx, 23 transitions, grade (wheels/LUT import/saved looks), adjustment layers | 17 fx + LUT + legalizer, 9 transitions, adjustment clips, 17 blend modes, track mattes | glitch/whip/light-leak/zoom-punch transitions, film looks, lift/gamma/gain + curves, scopes | M (transitions) / L (grading) | lib |
| Templates/library breadth | 66 templates incl. subscribe/like CTAs, emoji bursts, social stickers, 8 animated backgrounds, outros | 11 templates, 12 generators | ~25 social-first templates (hooks, stickers, subscribe, outros, animated backgrounds) | **H** | lib |
| 3D | three.js layers, 10 presets, glTF | none | 3D titles/objects | L | agent / plugin |
| AI features | model manager, pinned downloads, `ai.providers` router (local + remote) | none (REMAINING #8) | provider extension point | H (enabler for TTS/STT/music) | lib |
| Agent: recipes | `fc.start {script}` / `shortFromScript` builds a finished Short (moving bg per shot, hook title, word-timed captions, punch-ins, stickers, progress bar, music, CTA); listicle; podcastClip | none; short-from-script eval task costs 21 turns, 824k tokens, 142 s (mean task 11.4 turns, 435k) | one-call Short/listicle/podcast-clip | **H** | lib |
| Agent: QA | ~29 rules incl. static-visuals, low-contrast, buried-dialogue, edge-gap, text-overflow, template-slots; `qaFix`/`qaFixAll` verified and convergent | 20 rules on rendered pixels, crops, sound report, `fix:` command per finding | auto-apply fixes (`--fix`), static-visuals (retention), low-contrast, edge-gap | **H** (auto-fix) / M (rules) | lib |
| Agent: inspect | `agent.inspect(t)` (boxes, text, z, audio levels), query language, dry-run | `show` outline, `show --clip`, grep-able file, `--dry-run`, `look` crops, `--json` | structured per-time scene (boxes) | L | lib (`show --at t --json`) |
| Plugins | semver host, JSON + code plugins, 9 extension points, UI themes | semver plugin API, scaffold/test/trust, effects/transitions/generators/templates/commands/checks, core built on it | `ai.providers` point; declarative (JSON) templates/recipes | M | lib |
| Rendering/export | MP4 (VP9/AV1 fallback in headless), WebM, GIF, PNG, MP3/WAV, draft/standard/high, estimate | MP4 H.264/AAC, WebM, GIF, PNG, WAV/MP3, ProRes, alpha, SRT/VTT, stems, chapters, estimate, detach, parallel segments | none | – | – |
| Performance | 6.4–7× real time at 1080×1920 (SwiftShader WebGL) | 1.08–1.76× real time final, 0.30–0.83× draft | Michelangelo ahead | – | – |
| Stock imagery | neither (FC listed Openverse as a candidate after its Reel scored 4.5/10 for "no real imagery") | neither | real b-roll/images for script-only briefs | H | agent (network, licensing); lib stores attribution |
| Human UI, share links | full editor, workspaces, share links | none (by design) | – | L | out of scope |

## 2. Where Michelangelo is already ahead (evidence)

| Dimension | Michelangelo | FrameCraft | Source |
|---|---|---|---|
| Final render, 30 s 1080×1920 Short | 52.9 s (1.76× RT); text-only 32.5 s (1.08×); 4K HEVC 47.0 s (1.57×) | ≈ 6.4–7× RT (a 30 s Short ≈ 3.5 min) | bench/results/2026-10-04T08-02.md; AGENT-PLATFORM-PLAN §1.1 |
| Speed ratio | 3.6–5.9× faster on the same 4 vCPU | – | same bench |
| Draft / review | draft 0.30–0.83× RT; `look` 12 stills in 0.13–6.1 s (target < 10 s) | draft export several × faster than standard, still browser-bound | bench; agent.md §8 |
| Compositing | Skia 11 ms per 1080×1920 frame | SwiftShader WebGL 210–270 ms | DESIGN §1, LESSONS V1 |
| Project file tokens | 12 clips + 3 templates + captions = 37 lines, 4.2 KB (≈ 0.35 KB/entity); a 60-clip edit < 150 lines | 40 clips = 65 KB / 2,950 lines; 214 clips = 306 KB (~87k tokens), random ids, 100 KB of caches | measured here; AGENT-PLATFORM-PLAN §1.3 |
| Docs read per session | SKILL.md ≈ 2.6k tokens; topic guides on demand | agent.md ≈ 21k tokens + 58.6 KB tool list | file sizes |
| Surface | 70 commands, 9 verbs, no aliases, did-you-mean errors with line + fix | 238 tools, many legacy aliases | `mgl docs commands`; PLAN status |
| Edit ergonomics | exact-string edit of one line, `mgl edit` CLI, SDK, atomic batches, integer frames | browser page + Playwright; float seconds | SKILL.md; LESSONS |
| Agent outcomes | main set 93–97 % success, 11.4 turns, 435k tokens, 58.5 s, ≈ $0.33/task, 0 shell timeouts (baseline 0.056); held-out v2 80 %, 0.97 score | agent-use eval 2, 2.5 and 0.5/10 before hardening; north-star Reel 4.5/10 | evals/HISTORY.md; FC PLAN status |
| Setup | zero downloads when ffmpeg exists; `doctor --fetch` pinned build | Chromium + 68 MB dist; headless Chromium lacks H.264 | DESIGN §1; FC CLAUDE.md |
| Pro I/O | HEVC/ProRes/VFR/HDR input, ProRes + alpha output, stems, chapters, slip/slide/roll, nested comps | not available (VP9/AV1 fallback, no nesting) | REMAINING bar |

Conclusion: for **editing given media** Michelangelo is already cheaper and faster. The gaps are almost all in
**generating** content an agent does not have (voice, word timings, music, SFX, motion, social graphics) and in
**one-call workflows** that collapse 10–20 turns. That is where FrameCraft's Reel quality came from, and where an
agent without either library spends the most turns (hand-built ffmpeg/drawtext pipelines, keyframe arithmetic).

## 3. Cost model used for ranking

A typical high-quality Short: script → voice-over → word-timed captions → visuals (media or generated
backgrounds, motion every ~2 s) → hook title, stickers, CTA → music + SFX, ducking, −14 LUFS → QA → render.
Ranking weight = (turns/tokens saved per video × share of briefs affected) + (vision-score gain) + (minutes saved).
Reference costs: the eval mean is 11.4 turns / 435k tokens; the `short-from-script` task — the closest to the
owner's target video, and with a VO supplied — was the most expensive main task (21 turns, 824k tokens, 142 s)
and still produced no music, SFX, motion presets or stickers.

## 4. Top 15 gaps to close, ranked by expected reduction in cost per high-quality video

| # | Gap | Why it ranks here | Implementation sketch (lib unless noted) |
|---|---|---|---|
| 1 | **One-call Short from a script** | Replaces the 21-turn/824k-token loop with ~4 turns (new, look, fix, render); every Short brief | `mgl new shorts --script script.txt [--vo vo.wav] [--style viral] [--bg media/*]` → a core `recipe.short` command that composes existing commands (captions.from-text, template.apply, gen backgrounds, punch-ins every ~2 s, progress bar, CTA, music bed, duck, normalize) and prints `next:` lines; deterministic and QA-clean by test |
| 2 | **Word timings from speech (STT provider)** | Captions are on every voiced video; silence-split timing drifts on fast speech, and fixing cues by hand is many turns; also unlocks jump cuts on fillers and captions without a script | `ai.providers` point `transcribe`; default whisper.cpp or transformers.js `whisper-base` on CPU, weights fetched pinned by `doctor --fetch whisper`; `captions.from-speech <voice-clip>` writes cues with word times; `from-text` aligns script words to them |
| 3 | **Auto-apply QA fixes** | Each finding today costs a turn to run its `fix:`; FC's verified `qaFixAll` did it in one call and never regressed | `mgl check/look --fix [--severity warn]`: apply each finding's command in one transaction, re-run the rule, keep only fixes that remove the issue without new ones, loop to convergence, print a summary |
| 4 | **Music bed generator** | Nearly every social video has music; without it agents skip music (quality) or burn turns on ffmpeg synthesis; stock music needs network + licensing | generator `music` (audio): procedural, seedable, genre/mood/BPM/key/length, intensity curve, loopable; written as a cached WAV asset keyed by params; `marker.beats` works on it directly |
| 5 | **TTS voice-over** | Script-only briefs cannot have a voice today (flite is fixture quality); voice is the biggest retention factor after the hook | `ai.providers` point `speak`; default Kokoro-82M (ONNX, CPU, faster than real time) or Piper, pinned download; `audio.speak text=... voice=af_heart` → dialogue-bus clip + word timings for #2 |
| 6 | **Motion presets for any layer** | Retention needs motion every ~2 s; hand keyframes cost tokens and turns (and errors) per element | `motion.apply <clip> in=pop out=fade loop=float emphasis=pulse@2s stagger=...`: ~30 presets (in/out/emphasis/loop incl. kenBurns, shake, wiggle, breathe, punch, whip) expanded into plain keyframes or a `loop` field; same seam as text animations |
| 7 | **SFX library + auto-SFX** | Cheap polish judges notice (whoosh on transitions, pop on stickers); without it agents skip SFX | ~30 procedural seedable SFX as an audio generator; `audio.auto-sfx on=transitions,templates,cuts map='{...}'` places linked clips that move with their source |
| 8 | **Social template breadth** | Hooks, stickers, subscribe/like, outros, keyword callouts, animated backgrounds are reused in most videos; each template saves 3–8 turns of building | add ~25 templates: hook-title variants, keyword sticker/emoji pop, subscribe/like button, follow CTA variants, outro cards, comment/tweet card, before/after split, number counter callout, 4 animated backgrounds (aurora, gradient-flow, bokeh, grid); each must pass QA on all presets (existing test) |
| 9 | **Retention and legibility QA rules** | Catch quality failures the agent cannot see in 12 stills: frame holding still > 2 s, low text contrast, uncovered frame edge after zoom | checks `static-visuals` (frame-diff on sampled frames, fix: punch-in/kenBurns), `low-contrast` (WCAG on rendered text vs backdrop, fix: stroke/shadow/plate), `edge-gap` (fix: min scale) |
| 10 | **Viral caption styles + keyword emphasis** | Captions are the most visible element of a Short; named looks save style JSON trial-and-error | styles `hormozi`, `mrbeast`, `bounce`, `neon`, `word-by-word`; cue word flags `emph` (colour/scale/emoji) and `captions.emphasize words=[...]` |
| 11 | **Stylised transitions** | Variety across cuts was a top FC Reel critique ("the same flash every time") | add `whip` (directional blur + slide), `zoom-punch`, `glitch`, `light-leak`, `iris` (circle/shape reveal), `luma` (gradient wipe) via the public transition API; recipe #1 rotates them |
| 12 | **Display fonts** | 4 families limit the social look; agents otherwise fetch fonts mid-task (network, turns) | bundle 6–8 OFL display families (e.g. Montserrat, Bebas Neue, Luckiest Guy, Poppins, Oswald, Permanent Marker) with weights; `mgl docs fonts` lists them |
| 13 | **Audio-reactive / beat sync** | Beat-pulsed titles and cut-to-beat are standard in music-led edits; markers exist but properties cannot follow audio | `key.from-audio <clip> prop=scale source=music feature=beat min=1 max=1.15` writes keyframes from the existing analysis (no runtime expression engine) |
| 14 | **Motion blur + Lottie stickers** | Motion blur raises perceived polish on fast presets; Lottie opens a huge free sticker/icon ecosystem | per-clip `motionBlur` via sub-frame accumulation in Skia (draft off); Lottie as an asset kind rendered with a Node Lottie→Skia renderer (e.g. skottie via canvaskit) behind a plugin |
| 15 | **Grade presets and wheels** | Matters for real footage (YouTube talking heads), less for generated Shorts; LUTs already cover looks | `color` effect gains lift/gamma/gain + curves params; 6 bundled `.cube` looks (teal-orange, warm, cool, film, B&W, faded); a luma/RGB waveform tile in `look` |

Not ranked (low value per typical video or better left to the agent): 3D layers (plugin if demanded),
expressions (replaced by keyframe-writing commands #6/#13), stabilize and corner pin (one ffmpeg effect each,
add when a task needs them), structured `inspect(t)` (`show`, `--json` and crops already cover it), stock imagery
(the agent fetches; the library only needs an `attribution` field on assets), human UI and share links.

## 5. Notes for implementation order

- #2, #5 (and MusicGen if ever wanted) share one `ai.providers` extension point (REMAINING #8) with pinned,
  checksummed downloads via `doctor --fetch <model>`; everything must still work offline without them
  (`captions.from-text` silence timing, no voice) and say so in `mgl doctor`.
- #1 should be built last of the top five but designed first: it composes #2–#7, so each later item raises
  the recipe's output quality without changing its call.
- Measure each item with the §17 arms: add eval tasks "script-only Short (no VO, no media)" and
  "music + SFX polish" to the main set, plus a vision-score rubric, before closing the corresponding gaps.
