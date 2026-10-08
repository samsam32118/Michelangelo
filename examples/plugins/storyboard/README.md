# storyboard

A script linked to the timeline. Write the video as a Markdown storyboard of scenes and beats: each beat says
what is heard (a voice line), what is seen (shots) and what is on screen (text). `storyboard.apply` times the
beats and lays the clips out. Run it again after you change the script or the voice, and everything is re-timed.

```markdown
# Morning habits

## hook
> Most people waste their mornings.
shot: media/alarm.mp4 | in=2s
text: Stop wasting mornings | style=title

> Here are three habits that changed mine.
shot: media/desk.mp4
shot: gen:gradient #1e3c72 #2a5298
cut-on: three
transition: crossfade 0.3s

## habit1
> First, no phone for the first hour.
shot: media/phone-drawer.mp4
text: 1. No phone | at=+0.3s
sfx: media/whoosh.wav | at=-0.2s gain=-6

## outro
dur: 2s
text: Follow for more
```

| line | meaning |
|---|---|
| `## name` | a scene (its id is the name, lower-cased) |
| `> text` | a beat and its voice line; `>` alone starts a silent beat; `{#id}` at the end pins the beat id |
| `shot: <path \| asset id \| gen:<type> #colours k=v>` | a shot; several split the beat (evenly, or on `cut-on:` words). Options: `in=`, `fit=`, `sound=on` (videos are muted by default) |
| `text: <words>` | one text card per beat. Options: `style=`, `x=`, `y=`, `at=+0.3s`, `len=` |
| `sfx: <path \| asset id>` | a sound effect at the beat's start. Options: `at=` (may be negative), `gain=`, `len=` |
| `dur: 3s` / `dur: min 2s max 4s` | the beat's length; required on silent beats |
| `cut-on: three` | the word(s) of the voice line the shots cut on, one per cut |
| `transition: crossfade 0.3s` | into the beat's first shot |
| `note: ...` | ignored |

## Timing

- `voice=true` (or a voice id) speaks each line through the project's speak plugin (`audio.speak`). The picture
  cuts `lead` frames (3) before the voice starts, and each beat lasts as long as its line plus `pause` (0.25 s).
  When you change one line, only that line is spoken again.
- `vo=media/vo.wav` times the beats to a recording: each beat starts at its first word, found by aligning the
  script to the recording's loudness. Silent beats may only come before or after the voice.
- With neither, beats are timed at reading speed (`wps`, 2.6 words/s).
- A beat with no shot holds the shot before it. `dur:` stretches or trims a beat. `minShot` (0.6 s) is the
  shortest shot allowed.
- `captions=true` (or a style id) adds word-timed captions from the voice.

## On the timeline

Clips go on tracks `SB` (shots), `SBT` (text), `SBC` (captions), `SBV` (voice) and `SBX` (sound effects). Each
clip is tagged `sb:<beat>` and `sb-role:<role>`, so `grep '"sb:hook-2"'` finds a beat's clips. Every beat has a
range marker `sb-<beat>` (its note is the line), every scene has one named `sbs-<scene>`, and the `storyboard`
marker remembers the file and options. A second `storyboard.apply` re-times every tagged clip. It keeps
your hand edits to the other properties (`x`, `y`, `scale`, `fx`, ...) and drops voice files no longer used.
`storyboard.detach` turns them back into ordinary clips.

The `storyboard-sync` check (runs in `mgl check`, no render) reports any shot or card moved out of its beat by
hand, gaps between shots, and text cards too brief to read.

```sh
mgl plugin trust plugins/storyboard
mgl edit demo.mgl.json project.set plugins='{"storyboard": "^1.0.0"}'
mgl edit demo.mgl.json storyboard.apply video.storyboard.md voice=true captions=karaoke
mgl show demo.mgl.json          # beats are markers; clips carry their beat
# edit video.storyboard.md, then:
mgl edit demo.mgl.json storyboard.apply
```
