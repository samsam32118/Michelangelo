# collage-kit

The hand-cut **paper collage** look: black-and-white cut-outs slapped onto flat colour fields, moving in held
poses like stop motion. Two effects, two generators and three templates that share one idea: nothing eases, every
layer is re-placed by hand every few frames.

| kind | name | what |
|---|---|---|
| effect | `paper-boil` | stop-motion jitter: every `step` frames (default 3, "on threes") the layer lands up to `shift` px and `tilt`° off |
| effect | `ink-flat` | fills the layer's shape with one flat `color`, keeping its alpha (a silhouette cut from coloured paper) |
| generator | `paper-field` | a flat `color` field with paper mottle, a soft vignette, and `dust` specks and hairs re-rolled every `step` frames |
| generator | `dot-grid` | `cols` × `rows` paper squares revealed row by row with `lit` of them in an accent colour ("3 in every 1,000") |
| template | `cutout` | a sticker image (`asset`, a transparent PNG) pushed in `from` a side or popped, in 2-frame poses, with shadow and boil |
| template | `tape-label` | a strip of paper with typewriter `text`, held by two pieces of tape |
| template | `paper-number` | a huge number or word on a torn scrap of paper that drops in |

Everything is a pure function of (params, frame, seed), so renders are repeatable. The kit draws no photos: bring
your own cut-outs as PNGs with alpha (public-domain or your own images).

## Use it (trusted loading)

Plugins are code that runs on your machine with no sandbox, so a project loads one only when you name it **and**
trust it. Trust is a hash of every file in the folder: re-run `mgl plugin trust` after any change.

```sh
cp -r <michelangelo repo>/examples/plugins/collage-kit plugins/collage-kit
mgl plugin test plugins/collage-kit            # manifest, definition, type-check, tests, .preview.png
mgl plugin trust plugins/collage-kit           # after reading src/index.ts
mgl new reels -o collage.mgl.json
mgl edit collage.mgl.json project.set plugins='{"collage-kit": "^1.0.0"}'
mgl edit collage.mgl.json clip.add id=bg track=V1 len=4s gen='{"type": "paper-field", "color": "#1f3fe0"}'
mgl edit collage.mgl.json template.apply paper-number at=0 len=4s params='{"text": "74%", "y": 620, "size": 330}'
mgl edit collage.mgl.json template.apply tape-label at=0.5s len=3.5s params='{"text": "ONE STUDY'"'"'S ESTIMATE", "y": 300}'
mgl edit collage.mgl.json asset.add media/robot.png id=robot
mgl edit collage.mgl.json template.apply cutout at=1s len=3s params='{"asset": "robot", "from": "right", "y": 1250, "scale": 0.5}'
mgl look collage.mgl.json
```

Any layer can boil: `mgl edit collage.mgl.json fx.add <clip> type=paper-boil shift=3 tilt=0.4`.

## Notes

- `paper-number` estimates the scrap width from the text length; pass `width` (from the SDK's
  `p.services.measureText`) for an exact fit with wide or narrow glyphs.
- `cutout` keeps the image at its pixel size (`fit: none`) times `scale`, so stickers of different sizes stay sharp.
- Template text carries the tag `qa-ignore:text-overlap`: in a collage, text sits on paper on purpose.
- For film grain over the whole frame, add an adjustment clip with the built-in `grain` effect.

## Develop

```sh
mgl plugin test plugins/collage-kit
```

`evals/collage-kit-basic/` holds an eval task (`task.md` + `meta.json`) in the same format as Michelangelo's own.
