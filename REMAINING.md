# What remains for the v1 bar

Status as of 2026-10-04 (branch `claude/michelangelo-v1`, draft PR #1). Measured numbers are in
[bench/results](bench/results) and [evals/HISTORY.md](evals/HISTORY.md).

## v1 feature bar: where each item stands

| Item | State | Notes |
|---|---|---|
| Multi-track editing: trim, split, ripple, slip, slide, roll, speed, freeze | done | frame-exact, link groups (A/V) move together; time remap keyframes for speed ramps |
| Audio: volume and fades, buses, ducking, loudness normalisation | done | sidechain ducking measured within 0.4 dB of the requested amount; two-pass loudness |
| Text and shapes with keyframes, per-character/word animation | done | 12 text animation presets; easing set of CSS/Penner + bezier |
| Captions: SRT/VTT import, styles, word timing | done | VTT inline word times; `captions.from-text` times cues to a voice; karaoke highlight |
| Nested compositions | done | rational time mapping between rates; audio flattened through nests |
| Masks, blend modes | done | rect/ellipse/path, feather, add/subtract/intersect; 17 blend modes; track mattes |
| ≥ 8 effects, ≥ 8 transitions | done | 15 effects, 9 transitions, 7 generators, all on the public plugin API |
| Templates: intro, lower third, call to action | done | plus title, end-card, progress-bar, quote, listicle-item |
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
6. **Motion design depth.** No expressions, motion blur, 3D layers, motion paths with spatial bezier, or
   Lottie import yet; parenting exists. These are the main After Effects gaps.
7. **Colour.** Colour effect + LUTs only; no lift/gamma/gain wheels, curves or scopes in `look`.
8. **AI hooks.** The plugin API has no provider point yet for transcription (word timings from speech), TTS or
   segmentation; `captions.from-text` uses silence detection only. Add an `ai.providers` extension point.
9. **Importers/exporters.** The plugin kinds exist; no EDL/FCPXML/OTIO importer or exporter is shipped.
10. **Grader coverage.** Some main-set graders give credit to an untouched sandbox for invariants (reported as
    the baseline score); a vision-model grade on top of the objective checks is not implemented.
11. **Performance headroom.** Targets are met (see bench); heavy layer blurs at full HD and per-pixel plugin
    effects are the slowest paths (≈150–200 ms per 1080x1920 frame for small-radius Skia blurs).
