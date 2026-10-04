# Editing: trim, split, ripple, slip, slide, roll, speed, freeze

All edits are frame-exact commands (`mgl edit <file> <op> <clip> k=v`). Times accept frames or `"2s"`.
A media clip shows source frames `in … in + len × speed` at timeline frames `at … at + len`.
Clips on one track never overlap; a command that would overlap refuses and names a fix. Clips with the
same `link` (a video and its detached audio) are edited together unless `unlinked=true`.
Every edit is one undo step: `mgl edit <file> undo`.

The examples below build on one project with three 2-second clips cut from one source:

```sh
mkdir -p media
ffmpeg -v error -f lavfi -i testsrc2=s=640x360:r=30:d=12 -c:v libx264 -pix_fmt yuv420p -y media/src.mp4
mgl new youtube -o cut.mgl.json
mgl edit cut.mgl.json asset.add media/src.mp4 id=src
mgl edit cut.mgl.json clip.add id=a asset=src track=V1 at=0 len=2s
mgl edit cut.mgl.json clip.add id=b asset=src track=V1 at=2s len=2s in=3s
mgl edit cut.mgl.json clip.add id=c asset=src track=V1 at=4s len=2s in=6s
mgl show cut.mgl.json
```

## trim

Moves the head (`start=`) or the tail (`end=` or `len=`) of a clip; the content stays where it was in
time (a head trim advances `in`). With `ripple=true` later clips on the track shift to close or open the gap.

```text
before   |a·········|b·········|c·········|
trim b start=2.5s
after    |a·········|    |b····|c·········|     (gap; ripple=true closes it)
```

```sh
mgl edit cut.mgl.json clip.trim a end=1.5s
mgl edit cut.mgl.json clip.trim b start=2.5s ripple=true
```

## split

`clip.split <id> at=<comp time>` makes two clips; the second gets `in += (at − start) × speed`,
keyframes and cues are divided and re-based, and animations keep their clock (a text animation never
restarts at a cut). The new clip is `<id>-2` unless `newId=` names it.

```text
before   |b·················|
split at=3s
after    |b·······|b-2·······|
```

## ripple-delete / remove

`clip.ripple-delete <id>` removes a clip and pulls the later clips on its track left; `all=true` shifts
every track of the comp to keep sync. `clip.remove <id>` leaves the gap (or `ripple=true`).

```text
before   |a····|b·········|c····|
ripple-delete b
after    |a····|c····|
```

## slip

Changes which part of the source a clip shows, keeping its place and length on the timeline.

```text
source   0s ─────────[ in ······· in+len ]────────── 12s
slip by=0.5s                 →  [ in+0.5s ··· ]
timeline |a····|b·········|c····|     (unchanged)
```

```sh
mgl edit cut.mgl.json clip.slip b by=0.5s
```

## roll

Moves the cut between a clip and the next adjacent clip: the clip gets longer, the next one starts later
and its `in` advances by the same amount. Total length is unchanged.

```text
before   |b·········|c·········|
roll b by=10
after    |b············|c······|
```

```sh
mgl edit cut.mgl.json clip.roll b by=10
```

## slide

Moves a clip between its neighbours: its content and length stay, the previous clip's tail and the next
clip's head absorb the move.

```text
before   |a·········|b·····|c·········|
slide b by=-5
after    |a·······|b·····|c···········|
```

```sh
mgl edit cut.mgl.json clip.slide b by=-5
```

## speed

`clip.speed <id> speed=2` plays twice as fast and keeps the same source range, so the clip gets shorter
(`keep=len` keeps the length and uses more source instead; `ripple=true` shifts later clips). Speed is a
rational (`"3/2"`), audio keeps its pitch. Keyframes are not moved; `check` warns if some fall outside.
For a ramp, keyframe `remap` (source frame by clip frame).

```text
before   |c·········|            source 6s–8s
speed 2  |c····|                 source 6s–8s, half the time
```

```sh
mgl edit cut.mgl.json clip.speed c speed=2
```

## freeze

`clip.freeze <id> at=<comp time> len=<time>` holds the frame shown at `at` for `len`: the clip is split
there, a held clip (`speed: 0`, muted) is inserted, and later clips on the track ripple right.

```text
before   |c··········|
freeze at=4.5s len=1s
after    |c····|c-hold═════|c-2··|
```

```sh
mgl edit cut.mgl.json clip.freeze c at=4.5s len=1s
mgl edit cut.mgl.json clip.ripple-delete a
mgl show cut.mgl.json --frames
```

## move, link, nest

- `clip.move <id> at=4s` or `by=-10` or `track=V2` (linked clips move together).
- `clip.detach-audio <id>` puts a video's own audio on an audio track as a linked clip, for J and L cuts:
  trim the audio clip with `unlinked=true` so it starts before (J) or ends after (L) the picture cut.
- `clip.link ids='["a","a-audio"]'` links clips; `clip.nest ids='["a","b"]' id=intro` pre-composes clips
  into a new comp and puts one clip of it in their place.
- Transitions sit on the incoming clip, centred on the cut, and use the media beyond each clip's end as
  handles: `mgl edit cut.mgl.json transition.set c type=crossfade len=0.5s` (see effects.md).
