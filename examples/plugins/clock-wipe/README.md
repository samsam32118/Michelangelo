# clock-wipe

A transition: a clock hand sweeps a full turn around a centre point and reveals the incoming clip.

| param | default | |
|---|---|---|
| `start` | 0 | start angle in degrees (0 = 12 o'clock) |
| `clockwise` | true | |
| `cx`, `cy` | 0.5 | centre as fractions of the frame |

```sh
mgl plugin test plugins/clock-wipe
mgl plugin trust plugins/clock-wipe
mgl edit demo.mgl.json project.set plugins='{"clock-wipe": "^1.0.0"}'
mgl edit demo.mgl.json clip.set shot2 'transition.in={"type": "clock-wipe", "len": "1s"}'
```
