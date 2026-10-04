# confetti

A generator: seeded paper pieces fall, sway and tumble over the frame (transparent background), looping
seamlessly. Sizes and speeds are given for a 1080 px tall comp and scale with the comp.

| param | default | |
|---|---|---|
| `count` | 150 | pieces |
| `colors` | 6 bright colours | CSS colours |
| `size` | 14 | piece length (px) |
| `speed` | 260 | fall speed (px/s) |
| `spin` | 1.5 | turns per second |
| `sway` | 0.5 | sideways drift |
| `seed` | 1 | |

```sh
mgl plugin test plugins/confetti
mgl plugin trust plugins/confetti
mgl edit demo.mgl.json project.set plugins='{"confetti": "^1.0.0"}'
mgl edit demo.mgl.json clip.add 'gen={"type": "confetti", "count": 300}' at=2s len=3s
```
