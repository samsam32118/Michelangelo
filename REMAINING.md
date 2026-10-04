# What remains for the v1 bar

Status as of 2026-10-04 (branch `claude/michelangelo-v1`, draft PR #1). Measured numbers are in
[bench/results](bench/results) and [evals/HISTORY.md](evals/HISTORY.md).

## v1 feature bar: where each item stands

| Item | State | Notes |
|---|---|---|
| Multi-track editing: trim, split, ripple, slip, slide, roll, speed, freeze | done | frame-exact, link groups (A/V) move together; time remap keyframes for speed ramps |
| Audio: volume and fades, buses, ducking, loudness normalisation | done | sidechain ducking within 0.4 dB of the requested amount; two-pass loudness; audio effects on clips and buses (EQ, dehum, denoise, compressor, limiter, gate, de-esser); stems |
| Text and shapes with keyframes, per-character/word animation | done | 12 text animation presets; easing set of CSS/Penner + bezier |
| Captions: SRT/VTT import, styles, word timing | done | VTT inline word times; `captions.from-text` times cues to a voice; karaoke highlight |
| Nested compositions | done | rational time mapping between rates; audio flattened through nests |
| Masks, blend modes | done | rect/ellipse/path, feather, add/subtract/intersect; 17 blend modes; track mattes |
| ≥ 8 effects, ≥ 8 transitions | done | 17 video + 11 audio effects, 9 transitions, 12 generators (incl. waveform, spectrum, timecode), 11 templates, all on the public plugin API |
| Templates: intro, lower third, call to action | done | plus title, end-card, progress-bar, quote, listicle-item, slate, bars, countdown |
| Reframing between aspect ratios | done | `comp.reframe` with optional motion tracking of the subject |
| Renders: still, contact sheet, draft, final; MP4 H.264/AAC, WebM, GIF, PNG, WAV/MP3 | done | also ProRes `.mov`, alpha (`--alpha`), SRT/VTT export, detached renders |
| HEVC / H.264 / ProRes input | done | rotation metadata, VFR via a frame index, HDR tone-mapped when zscale exists |
| Plugin system with scaffold, tests, trust | done | 4 example plugins; core effects use only the public API (test-enforced) |

## Known gaps and next steps

1. **ffmpeg downloads for macOS and Windows.** Only linux-x64/arm64 static builds are pinned (GitHub release
   assets were unreachable from this session). Pin BtbN/gyan/evermeet builds with checksums from a machine that
   can reach them.
2. **npm name.** `michelangelo` is taken; publishing needs a scoped name (owner's decision). Nothing has been
   published.
3. **Eval isolation.** Agents run with "audit" isolation (fresh dir and HOME, allowlisted tools, violations
   recorded and fatal when they touch the repo, evals or other sandboxes), not in a separate container. Running
   the held-out set in fresh cloud sessions would remove the remaining doubt. See DESIGN §16.1.
4. **Source-only effects with keyframed parameters** (e.g. an animated LUT intensity) reopen a decoder per
   frame: bounded but slow. Give such effects a layer-stage fallback or evaluate filter expressions in ffmpeg.
5. **Plugin dependencies.** The trust hash covers a plugin's own files, not its `node_modules`.
6. **Motion design depth.** No expressions, motion blur, 3D layers, motion paths with spatial bezier, keyframe
   loops, or Lottie import yet; parenting, keyframed masks and trim paths (start/end/offset) exist. These are the
   main After Effects gaps.
7. **Colour.** Colour effect, LUTs and a broadcast legaliser only; no lift/gamma/gain wheels, curves or scopes in
   `look` (a luma-range QA check exists).
8. **AI hooks.** Plugin API 1.4 has `speak` and `transcribe` providers (`audio.speak`, `captions.from-speech`) and
   exports the speech-timing helpers. Example plugins: `kokoro-voice` (neural TTS, model downloaded at run time) and
   `flite-voice`. Word alignment by sound covers voices without timings. No transcription (Whisper) or segmentation
   plugin ships yet.
9. **Importers/exporters.** The plugin kinds exist; no EDL/FCPXML/OTIO importer or exporter is shipped.
10. **Grader coverage.** Some main-set graders give credit to an untouched sandbox for invariants (reported as
    the baseline score). The vision judge (`--vision`) exists but has not been run across the full sets.
11. **Multicam.** Angle cuts work with clip.split/remove, but there is no audio-waveform sync or angle-switch command.
12. **Keyframed audio-effect parameters** are read once per clip (not animated over time).
13. **Performance headroom.** Targets are met (see bench); heavy layer blurs at full HD and per-pixel plugin
    effects are the slowest paths (≈150–200 ms per 1080x1920 frame for small-radius Skia blurs).
14. **Cost evals (DESIGN §17).** The with/without-library comparison has only a one-task smoke run (gif-export).
    The full baseline run failed before any agent started: the eval user had no API credentials in this session.
    Re-run `node evals/run.mjs --arm with|without --vision` on main and heldout2 (on 838fc03 for the
    pre-feature baseline, then on this head), then `node evals/compare.mjs`.
15. **Template library.** On purpose, only a couple of high-quality items per kind (hook-title and outro
    templates, hormozi and word-pop caption styles, whip and zoom-punch transitions, two fonts). A larger library
    is a separate effort.
16. **Recipe Short render speed.** A `mgl new shorts --script` Short (animated noise and gradient backgrounds,
    particles, glow, transitions) drafts at about 2.4x real time on 4 vCPUs (was 4x before the glow became a
    gradient), above the 1x draft target the typical-Short benchmark meets. The per-pixel noise generator and
    particles are the next costs; add the recipe Short to `npm run bench`.
