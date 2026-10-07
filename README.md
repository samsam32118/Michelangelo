# Michelangelo

Video editing and motion graphics as a TypeScript library and CLI (`mgl`), built first for AI coding agents.

An agent working with Michelangelo never watches a video. It uses:

- small project files with one entity per line;
- commands that print at most 40 lines;
- a storyboard of the whole video, as text and as one image;
- contact sheets and sound reports;
- QA findings that come with a ready-to-run fix.

The aim is a finished, good-looking video with fewer agent turns, fewer tokens and less render time than doing it by hand with ffmpeg.

Rendering is native: Skia composites the frames and ffmpeg handles decoding, encoding and audio. No browser is involved.

## Install

You need Node.js 22 or newer, and git.

```sh
curl -fsSL https://raw.githubusercontent.com/samsam32118/Michelangelo/main/install.sh | bash
```

The script does the following:

1. Clones the repository to `~/.local/share/michelangelo/src`.
2. Builds it.
3. Installs the `mgl` command globally. If npm's global folder is not writable, it installs into `~/.local` and prints the `PATH` line to add.
4. Runs `mgl doctor --fetch`, which downloads a pinned, checksummed ffmpeg build to `~/.cache/michelangelo` when your system ffmpeg lacks something.

Running the script again updates the install.

Options go after `bash -s --`:

```sh
# also install the agent skill for Claude Code (~/.claude/skills/michelangelo/SKILL.md)
curl -fsSL https://raw.githubusercontent.com/samsam32118/Michelangelo/main/install.sh | bash -s -- --skill

# a specific branch, tag or commit; keep your own ffmpeg
curl -fsSL https://raw.githubusercontent.com/samsam32118/Michelangelo/main/install.sh | bash -s -- --ref v0.1.0 --no-ffmpeg
```

Each option also has an environment variable: `--ref` is `MGL_REF`, `--dir` is `MGL_DIR`, `--skill` is `MGL_SKILL=1` and `--no-ffmpeg` is `MGL_NO_FFMPEG=1`.

Check the install:

```sh
mgl --version   # mgl 0.1.0 (plugin API 1.4.0, ...)
mgl doctor      # node, ffmpeg (codecs and filters), fonts, providers: "ready: nothing missing"
```

<details>
<summary>Install by hand, or use the library from your own code</summary>

```sh
git clone https://github.com/samsam32118/Michelangelo.git && cd Michelangelo
npm ci && npm run build
npm install -g "$(npm pack --silent | tail -n 1)"   # the mgl CLI
mgl doctor --fetch                                 # ffmpeg, if needed
```

To use the SDK in a Node project, add the package to that project:

```sh
npm install ~/.local/share/michelangelo/src   # or the path of your clone
```

```ts
import { open } from 'michelangelo';
const p = await open('video.mgl.json');
await p.edit([{ op: 'clip.add', text: 'Hello', track: 'T1', len: '2s', style: 'title' }]);
await p.save();
```

To use your own ffmpeg, set `MGL_FFMPEG=/path/to/ffmpeg`. It must be version 6 or newer, with libx264 and aac.
</details>

## Quick start

A vertical Short from a script, in one call:

```sh
echo "Three tips for better sleep. Keep the room cold. No screens after ten." > script.txt
mgl new shorts --script script.txt          # backgrounds, hook, captions, progress bar, CTA, music, SFX
mgl show video.mgl.json --scenes            # the storyboard as text: one line per scene
mgl look video.mgl.json                     # the storyboard image + QA findings + sound report
mgl render video.mgl.json video.mp4         # estimates first, then renders and verifies
```

`mgl new shorts --script` also takes:

- `--vo voice.wav`: captions follow your voice-over;
- `--voice <id>`: generate the voice-over with a speech plugin;
- `--media a.mp4,b.jpg`: b-roll instead of generated backgrounds;
- `--style viral|bold|clean`;
- `--music bed.mp3|none`;
- `--cta "Follow for more"|none`.

To edit by hand:

```sh
mgl new shorts -o edit.mgl.json                        # 1080x1920, 30 fps
mgl edit edit.mgl.json clip.add src=media/clip.mp4 track=V1 fit=cover
mgl edit edit.mgl.json clip.add text="Three tips to focus" track=T1 len=2.5s style=title id=title
mgl edit edit.mgl.json motion.apply title in=pop out=fade
mgl show edit.mgl.json                                 # the outline, one line per clip
mgl check edit.mgl.json --fix                          # QA, and apply the fixes that are verified to help
mgl render edit.mgl.json out.mp4 --draft               # fast preview render
```

The CLI has nine verbs:

| Verb | Use |
|---|---|
| `new` | create a project, or a whole Short from a script |
| `show` | outline the project, or the storyboard as text (`--scenes`, `--scene n`) |
| `edit` | run typed commands, which are validated, undoable and dry-runnable |
| `check` | QA without rendering |
| `look` | render the storyboard (or a contact sheet) and run QA and sound checks |
| `render` | render the output, with its storyboard next to it |
| `docs` | print the documentation |
| `plugin` | create, test and trust plugins |
| `doctor` | check the environment |

Every verb takes `--json` and exits with one of three codes:

- 0: ok;
- 1: the input is wrong;
- 2: the environment is wrong.

## The storyboard

The person asking for a video rarely opens the project, and the agent never watches the video. The storyboard is
one map of the video that both can read: the video as numbered **scenes**, each with its words, its time, a picture
and its **six lanes** (picture, graphics, captions, voice, music, sfx). Lanes are worked out from what each clip is;
effects, masks and transitions show as marks on their clip.

Scenes come from the story, in this order:

1. ranges you marked as scenes: `mgl edit video.mgl.json marker.add at=6s len=3s scene=true note="show a timer"`
   (`marker.set <id> scene=true len=3s` turns an existing marker into one). A marked scene with nothing in it yet
   is an `idea`, so you can drop an idea anywhere, even in a finished video;
2. otherwise sentences of the captions;
3. otherwise shots on the bottom picture track;
4. otherwise 5-second chunks.

Each scene carries at most two marks: `idea`, ⚠ (QA found a problem in it, from `mgl look`) and ● (it changed since
the previous storyboard, with the change in words: `title higher (y 691→500)`, `new whoosh.wav`, `(by hand)`). The
storyboard keeps a copy of the project it was made from in `.mgl/<name>/storyboard/`, so ● needs no step from
anyone. Nothing is approved or locked: it always shows the project as it is now.

It has three levels, as text for agents and as images and a page for people:

| Level | Text | Image |
|---|---|---|
| 1, the whole video | `mgl show video.mgl.json --scenes` (≤ 40 lines) | `mgl look video.mgl.json` (`sheet.png` laid out as the storyboard; `storyboard.html` next to it) |
| 2, one scene | `mgl show video.mgl.json --scene 3` (each lane item by item, with file lines) | `mgl look video.mgl.json --scene 3` (its moments and each layer alone) |
| 3, one clip | `mgl show video.mgl.json --clip bg3` | `mgl render video.mgl.json f.png --still 6s` |

`mgl look` with `--at`, `-n` or `--cuts` makes the plain contact sheet instead. QA checks the same frames either way
(12 evenly spaced, or the ones you name).
`mgl render` writes `<out>.storyboard.png` and `<out>.storyboard.html` next to every video or GIF
(`--no-storyboard` turns it off). `mgl edit` adds one line naming the scenes an edit touched:

```text
scenes: 3 "Work in 25-minute blocks", 4 "Follow for more"
```

The page is one static file with an inline script. Scene cards (with their layers, first issue and first change)
and the storyboard as text are plain HTML; the lane strip draws every clip and caption cue as its own block. Click a
scene for level 2 (its issues, changes, words, what is in it and what runs across the whole video; the scenes with ⚠
or ● also get their start and end and each layer alone, which you can switch on and off), an element for its times,
settings and line in the project file; filter by issues or changes; `copy scene` copies the scene as text to paste
into chat. It reads the project and never writes it. `mgl show --scenes` repeats the ⚠ of the last look.

For Codex and other agents that read `AGENTS.md`, add:

```markdown
## Video (Michelangelo)
- Start from `mgl show <file> --scenes`; dig in with `mgl show <file> --scene <n>`.
- After each round, hand over the storyboard: `mgl look <file>` (image `.mgl/<name>/look/sheet.png` and the page
  `storyboard.html`), or the `<out>.storyboard.png` / `.html` that `mgl render` writes.
- Refer to scenes by number and words: scene 3 "Work in 25-minute blocks".
- Mark a scene or an idea: `mgl edit <file> marker.add at=6s len=3s scene=true note="..."`.
```

Claude Code reads the same instruction from [SKILL.md](SKILL.md).

## What it can do

- **Editing.** Cuts are exact to the frame: trim, split, ripple, slip, slide, roll, speed, freeze and time remap. You can nest compositions and reframe 16:9 footage to 9:16 with tracking. Input can be H.264, HEVC or ProRes.
- **Motion graphics.**
  - Text and shapes animate with keyframes, per-word and per-character animation, and 37 motion presets (pop, slide, whip, wiggle, ...).
  - Masks, mattes, blend modes, parenting and trim paths.
  - 28 effects, 11 transitions, 12 generators (gradients, waveforms, spectrum) and 13 templates (hook title, lower third, call to action, progress bar, outro, ...).
- **Captions.** SRT and VTT import and export, word timing taken from silences or from a speech plugin, active-word highlight and `*keyword*` emphasis. Caption styles include hormozi and word-pop.
- **Audio.**
  - Buses, ducking under the voice, loudness normalisation, 11 audio effects and stems.
  - Music and sound effects generated offline, and automatic sound effects on cuts and transitions.
- **QA.** `look` and `check` find captions outside safe zones, overlaps, low contrast, static stretches, loudness problems and more. `--fix` applies only the fixes that are verified to help.
- **Output.** MP4, WebM, ProRes, GIF, PNG sequences, WAV, MP3, SRT, VTT and chapter files.
- **Plugins.**
  - Effects, transitions, generators, templates, commands, checks, importers, exporters, styles, motion presets, and speech and transcription providers.
  - Public, semver-versioned API (`michelangelo/plugin`, 1.4.0). Run `mgl plugin new` for a scaffold.
  - Eight examples in [examples/plugins](examples/plugins). Two are text-to-speech voices: `kokoro-voice` (natural,
    Kokoro-82M on the CPU) and `flite-voice` (zero downloads); `collage-kit` is a paper-collage kit of effects,
    generators and templates.

## Documentation

- **Agents:** [SKILL.md](SKILL.md) (also `mgl docs`).
- **Reference:** [docs/reference](docs/reference/) (`mgl docs <topic>`).
- **Recipes:** tested recipes for common jobs in [docs/reference/recipes.md](docs/reference/recipes.md).
- **Design:** [DESIGN.md](DESIGN.md).
- **Lessons** from FrameCraft, the browser-based predecessor: [LESSONS.md](LESSONS.md).
- **What is left:** [REMAINING.md](REMAINING.md).
- **Evals:** [evals/tasks](evals/tasks/README.md).

## Status (2026-10-04)

Measured on a cloud container with 4 vCPUs and no GPU. Details are in [bench/results](bench/results) and [evals/HISTORY.md](evals/HISTORY.md).

Each benchmark project is 30 s long. The "look" column times a 12-frame contact sheet, draft renders at 540x960 and final at 1080x1920.

| Benchmark | look | draft | final |
|---|---|---|---|
| Typical Short (2 video layers, captions, text, shapes, music + voice) | 3.1 s | 0.76× real time | 1.76× real time |
| Text-only motion graphics | 0.1 s | 0.30× | 1.08× |
| 4K HEVC + 1080p picture-in-picture | 6.1 s | 0.83× | 1.57× |

The targets were under 10 s for look, at most 1× real time for draft and at most 3× for final. FrameCraft rendered the final at 6.4× real time on the same machine.

Agent evals ran Claude Code (`claude -p`) in a fresh directory and HOME, with only the packed library and its docs:

| Set | M1 | M2 | M3 | M4 |
|---|---|---|---|---|
| Main (30 tasks; 33 since M4) | 25/30 | 27/30 | 29/30 | 28/30 (2 grader bugs, since fixed) |
| Held-out v1 (10 tasks; names exposed, now a regression set) | – | 5/10 | 8/10 | 7/10 |
| Held-out v2 (10 tasks; unseen by the builder) | – | 8/10 | 8/10 | 8/10 |

The full comparison of cost with and without the library has not been run yet; see [REMAINING.md](REMAINING.md).

## Development

```text
npm ci                   install dependencies
npm run typecheck        tsc --noEmit
npx vitest run           unit tests (every code block in SKILL.md and docs/reference runs in tests/unit/docs-examples.test.ts)
npm run mgl -- <verb>    the CLI from source
npm run docs             regenerate docs/reference/{commands,effects,errors}.md from the code
npm run schema           regenerate schema/v1.json from the zod schemas
npm run docs:check       fail if either is out of date
npm run build            dist/ (tsc) + make the CLI executable
npm run bench            the render benchmark
```

## Licence

[FSL-1.1-ALv2](LICENSE.md): source-available, and each release becomes Apache-2.0 after two years. ffmpeg is not bundled; it is fetched at run time.
