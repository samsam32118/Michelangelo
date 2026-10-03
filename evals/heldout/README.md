# Held-out eval set (10 tasks)

**Held-out set: the builder must not read this directory.** Only the eval runner and graders touch it
(DESIGN.md §11.3).

Same format as `evals/tasks/`: `task.md` (the prompt), `meta.json` (fixtures, objective checks, tags,
timeout), and later `setup.mjs` + `grade.mjs`. Every grader also asserts the output is not empty, black,
static or silent (evals/lib `assertNotEmpty`). Grader-only reference files named in a task's fixtures
are never copied into the agent's sandbox.

| # | id | tags | checks |
|---|---|---|---|
| 1 | [podcast-angle-switch](podcast-angle-switch/task.md) | editing, multicam | 6 |
| 2 | [audiogram-square](audiogram-square/task.md) | audio, motion, weak (weak) | 4 |
| 3 | [youtube-chapters](youtube-chapters/task.md) | markers, text, export | 4 |
| 4 | [delivery-pack](delivery-pack/task.md) | export, media | 5 |
| 5 | [caption-reflow-sidecar](caption-reflow-sidecar/task.md) | captions, export | 5 |
| 6 | [hum-cleanup](hum-cleanup/task.md) | audio, effects, weak (weak) | 4 |
| 7 | [follow-the-box](follow-the-box/task.md) | motion, tracking, weak (weak) | 4 |
| 8 | [quote-card-plugin](quote-card-plugin/task.md) | plugins, templates | 5 |
| 9 | [stats-bar-chart](stats-bar-chart/task.md) | motion, data, text | 5 |
| 10 | [highlight-reel-script](highlight-reel-script/task.md) | sdk, editing, batch | 6 |
