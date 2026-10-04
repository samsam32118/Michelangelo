# glitch

A layer effect: RGB channel split plus horizontal slices shifted sideways. The pattern is re-rolled every
`hold` frames from `(seed, frame)`, so any frame renders the same on its own.

| param | default | |
|---|---|---|
| `amount` | 0.5 | 0 = off, 1 = heavy |
| `slices` | 8 | horizontal bands |
| `split` | 6 | RGB split in px at amount 1 |
| `hold` | 3 | frames each pattern is held |
| `seed` | 1 | |

```sh
mgl plugin test plugins/glitch
mgl plugin trust plugins/glitch
mgl edit demo.mgl.json project.set plugins='{"glitch": "^1.0.0"}'
mgl edit demo.mgl.json clip.set shot1 'fx=[{"type": "glitch", "amount": 0.8}]'
```
