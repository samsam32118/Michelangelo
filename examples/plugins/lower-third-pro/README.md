# lower-third-pro

A template and a command. The template `lower-third-pro` builds a name + role on a dark plate with an accent
bar that grows in; it stays inside the vertical safe zone. The command `lower-third-pro.add` applies it in one
step, each layer on a new track on top of the comp.

| param | default | |
|---|---|---|
| `name` | "Ada Lovelace" | |
| `role` | "" | second line (optional) |
| `accent` | "#ffb800" | bar and role colour |
| `plate` | "#111318" | |
| `side` | "left" | `left` or `right` |

```sh
mgl plugin test plugins/lower-third-pro
mgl plugin trust plugins/lower-third-pro
mgl edit demo.mgl.json project.set plugins='{"lower-third-pro": "^1.0.0"}'
mgl edit demo.mgl.json lower-third-pro.add "Ada Lovelace" role=Engineer at=2s
mgl edit demo.mgl.json template.apply lower-third-pro at=8s params='{"name": "Grace Hopper", "side": "right"}'
```
