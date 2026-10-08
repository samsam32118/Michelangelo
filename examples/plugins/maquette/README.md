# maquette

Animated **3D shots** for Michelangelo, rendered headless with **Blender** (Cycles), from a small Python shot file or
an **OpenUSD** stage. It ships a procedural character, **Michelangelo**, the editor's mascot: a hovering robot with a screen face, amber
eyes, a coral antenna and a red beret. No downloaded models: every shot is code, so it is reproducible and
licence-clean.

```sh
cp -r <michelangelo repo>/examples/plugins/maquette plugins/maquette
mgl plugin test plugins/maquette
mgl plugin trust plugins/maquette                       # after reading src/index.ts and blender/*.py
mgl edit video.mgl.json project.set plugins='{"maquette": "^0.1.0"}'
mgl edit video.mgl.json maquette.still shots/wave.py frames=[1,24,40]     # quick PNGs in .mgl/<name>/
mgl edit video.mgl.json maquette.shot shots/wave.py track=V2 at=1s         # draft (cheap), added as a clip
mgl edit video.mgl.json maquette.shot shots/wave.py track=V2 at=1s quality=final id=wave-final   # after approval
mgl edit video.mgl.json maquette.shot shots/pop.py track=V3 usd=true       # also writes the stage as OpenUSD
```

- **Cheap first, expensive last.** Everything renders as a **draft** by default: 360x450, 2 samples (denoised), no
  motion blur, every second frame held (12 fps), about 1–2 s a frame, roughly 12x cheaper than the final. Use drafts
  for the storyboard (`maquette.still`, a few seconds a panel) and the animatic (`maquette.shot`, then `mgl look` and a
  draft render). Only when a person has watched the animatic and the story works, re-run each shot with
  `quality=final` (the shot's own resolution and samples, 24 fps, motion blur).
- `maquette.shot` renders, encodes and adds the clip. A **transparent** shot (`scene_setup(..., transparent=True)`)
  becomes ProRes 4444 with alpha (`.mov`), ready to sit over a talking head; an opaque one becomes H.264 (`.mp4`).
  Files go to `media/generated/maquette-<shot>-<hash>.*` and are **reused** until the shot, its settings or the kit
  change (the hash covers all three). `len=` trims, `fit=` sets the fit, `res=` and `samples=` override the shot.
- `maquette.still` renders a few draft frames into the work folder: the storyboard panels. An agent cannot watch the
  shot; it can read stills.
- Shots: a `.py` file with `build(m)` (m is `blender/maquette.py`), or an OpenUSD text stage `.usda` with a camera
  (convert binary stages with `usdcat in.usdc -o shot.usda`). `usd=true` exports what was rendered as `.usdc`.

## Writing a shot

```python
def build(m):
    m.scene_setup(48)                       # frames (24 fps), 720x900, Cycles, denoised; transparent=True for overlays
    m.backdrop((0.86, 0.72, 0.92))          # a seamless studio sweep
    m.studio_lights()                       # warm key, cool fill and rim
    c = m.Michelangelo(loc=(0, 0, 0.35))
    c.hover(1, 48); c.wave(4, cycles=3); c.blink(36); c.smile_(4, 1.2)
    m.camera((0.9, -6.2, 1.9), (0, 0, 1.45), lens=55, dof=6.2)
```

The character's controls: `root` (position, scale), `torso` (lean, squash via `c.squash(f, k)`), `head` (tilt, nod, turn),
`eyeL`/`eyeR` (`c.blink`, `c.look`, `c.eyes_shape` for wide, squint or happy eyes), `c.smile_` / `c.gasp` (mouth),
`c.arm('L'|'R', f, up=, fwd=)`, `c.wave`, `antenna` and `beret` (give them a few frames of lag for follow-through).
Props: `m.rbox`, `m.sphere`, `m.cylinder`, `m.text` (Michelangelo's fonts), `m.diamond`, `m.lightbulb`,
`m.magnifier`, `m.paper`, and a creator's desk: `m.desk_set(night|dawn|morning)`, `m.monitor`, `m.phone` (lock screen with notification cards), `m.pencil_cup`, `m.mug`, `m.sticky`, `m.heart`, `m.sleeve`. Acting extras: `m.eyes_power(c, f, k)` (eyes on or off), `m.wink(c, f)`. Animate anything with `m.key(ob, 'location', frame, value)` / `m.keys(ob, path, [...])`.

## Blender

`$MAQUETTE_BLENDER` (a Blender binary, run with `-b`), else `$MAQUETTE_PYTHON` (a Python with `bpy`:
`pip install bpy`, Python 3.13 for bpy 5.x), else `python3`. EEVEE needs a GPU, so the kit renders with Cycles: on a
4-core CPU a 720x900 frame takes 6–10 s, about a minute per second of animation. ffmpeg: `$MGL_FFMPEG` or `ffmpeg`.

## Files

- `src/index.ts`: the two commands (Node built-ins load lazily).
- `blender/maquette.py`: scene, lights, materials, props, animation helpers, the Michelangelo character.
- `blender/render_shot.py`: renders one shot (frames, stills, OpenUSD export).
- `shots/wave.py`: a 2-second example.
- `test/maquette.test.ts`: names, cache hash, Blender command line, refusing non-shots.
