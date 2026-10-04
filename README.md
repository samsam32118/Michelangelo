# Michelangelo

Video editing and motion graphics as a TypeScript library and CLI, designed first for AI coding agents:
small line-oriented project files, commands that print ≤ 40 lines, contact sheets and sound reports
instead of video playback, estimates before long renders, and errors that name the fix.

```sh
mgl new shorts                                   # video.mgl.json, 1080x1920 30 fps
mgl edit video.mgl.json clip.add src=media/clip.mp4 track=V1 fit=cover
mgl edit video.mgl.json clip.add text="Three tips to focus" track=T1 len=2.5s style=title
mgl show video.mgl.json                          # the outline, one line per clip
mgl look video.mgl.json                          # .mgl/video/look/sheet.png + QA + sound report
mgl render video.mgl.json out/video.mp4 --draft  # est. first, then render and verify
```

The CLI (`mgl`, also `michelangelo`) has nine verbs: `new`, `show`, `edit`, `check`, `look`, `render`,
`docs`, `plugin`, `doctor`. Every verb takes `--json` and exits 0 (ok), 1 (the input is wrong) or 2 (the
environment is wrong). The SDK (`import { open, create } from 'michelangelo'`) uses the same commands.

- Agent guide: [SKILL.md](SKILL.md) (also `mgl docs`); reference: [docs/reference](docs/reference/) (`mgl docs <topic>`).
- Design: [DESIGN.md](DESIGN.md); lessons from FrameCraft: [LESSONS.md](LESSONS.md); evals: [evals/tasks](evals/tasks/README.md).
- Requirements: Node ≥ 22, ffmpeg ≥ 6 with libx264 and aac (`mgl doctor` checks; `mgl doctor --fetch` downloads a pinned build).

## Development

```text
npm run typecheck        tsc --noEmit
npx vitest run           unit tests (every code block in SKILL.md and docs/reference runs in tests/unit/docs-examples.test.ts)
npm run mgl -- <verb>    the CLI from source
npm run docs             regenerate docs/reference/{commands,effects,errors}.md from the code
npm run schema           regenerate schema/v1.json from the zod schemas
npm run docs:check       fail if either is out of date
npm run build            dist/ (tsc) + make the CLI executable
```

Licence: [FSL-1.1-ALv2](LICENSE.md) (source-available; each release becomes Apache-2.0 after two years).
