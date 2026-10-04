# channel-mix

A Michelangelo effect plugin: a layer effect that tints a layer towards a colour. Start from `src/index.ts`; it imports only `michelangelo/plugin`.

## Develop

```sh
mgl plugin test plugins/channel-mix     # manifest, definition, type-check, tests, .preview.png
```

Tests live in `test/` and run with `node --test` using `michelangelo/testing`
(`renderEffect`, `renderTransition`, `renderGenerator`, `runCommandOn`, `checkContext`, `pixel`, `meanColor`, ...).
Keep `src/index.ts` to erasable TypeScript (no enums or namespaces): Node runs it directly.

## Use it in a project

```sh
mgl plugin trust plugins/channel-mix    # plugins next to a project load only once trusted (re-run after edits)
mgl edit demo.mgl.json project.set plugins='{"channel-mix": "^0.1.0"}'
mgl edit demo.mgl.json clip.set <clip> 'fx=[{"type": "channel-mix", "amount": 0.8}]'
```

Plugins are code that runs on your machine with no sandbox: only trust plugins you have read.

## Eval

`evals/channel-mix-basic/` holds an eval task for this plugin (`task.md` + `meta.json`), in the same format as Michelangelo's own evals.
