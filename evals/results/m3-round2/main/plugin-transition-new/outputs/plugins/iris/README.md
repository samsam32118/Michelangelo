# iris

A Michelangelo transition plugin: an iris transition (a circle grows from the centre revealing the next clip). Start from `src/index.ts`; it imports only `michelangelo/plugin`.

## Develop

```sh
mgl plugin test plugins/iris     # manifest, definition, type-check, tests, .preview.png
```

Tests live in `test/` and run with `node --test` using `michelangelo/testing`
(`renderEffect`, `effectFilters` (source/audio stages), `renderTransition`, `renderGenerator`, `runCommandOn`, `checkContext`, `pixel`, `meanColor`, ...).
Keep `src/index.ts` to erasable TypeScript (no enums or namespaces): Node runs it directly.

## Use it in a project

```sh
mgl plugin trust plugins/iris    # plugins next to a project load only once trusted (re-run after edits)
mgl edit demo.mgl.json project.set plugins='{"iris": "^0.1.0"}'
mgl edit demo.mgl.json clip.set <second clip> 'transition.in={"type": "iris", "len": "1s"}'
```

Plugins are code that runs on your machine with no sandbox: only trust plugins you have read.

## Eval

`evals/iris-basic/` holds an eval task for this plugin (`task.md` + `meta.json`), in the same format as Michelangelo's own evals.
