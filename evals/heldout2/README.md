# Held-out set v2 (10 tasks)

**Held-out set v2: the builder must not read this directory.** Only the eval runner (`node evals/run.mjs --set heldout2`)
and its graders touch it.

Same format as `evals/tasks/` and `evals/heldout/`: each task has `task.md` (the prompt), `meta.json` (id, tags, timeout,
expects_weak, fixtures, checks), `setup.mjs` (`setup(dir)`: fixtures from ffmpeg lavfi / flite / hand-written files; input
hashes in `dir/.setup.json`, grader-only files in `dir/.golden/`), `grade.mjs` (`grade(dir)` -> `{pass, score, checks}`,
plain ffmpeg/ffprobe and raw project JSON only) and `reference.mjs` (a plain-ffmpeg solution used only to validate the grader).
Shared helpers live in `_lib/` (they build on `evals/lib/`).

`node evals/heldout2/_validate.mjs [task ...] [--keep]` checks the graders: the grade must fail on a fresh setup with no
outputs, and must pass on the reference solution.
