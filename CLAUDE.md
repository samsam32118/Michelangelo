# Michelangelo: agent notes

- Read DESIGN.md first. `src/core/schema/` is the data contract: extend it additively, never break a field.
- **Never open `evals/heldout/`** (or grep into it). It is the held-out eval set; only `evals/run.mjs` and
  its graders read it. Builders who read it invalidate the eval.
- Do not copy, paste or translate code from FrameCraft (`samsam32118/videoaftereffects`). Record any
  borrowed idea in LESSONS.md.
- Node 22, TypeScript strict, ESM. No browser anywhere in the package.
- Directory ownership when working in parallel: core/, render/, media/, qa/, builtin/, plugin/, cli/, sdk/,
  docs/, evals/. Touch only the directories your task owns unless told otherwise.
- Built-in effects/transitions/generators/templates (`src/builtin/`) import only from `src/plugin/api` (the
  public plugin API). A test enforces it.
- Licence: FSL-1.1-ALv2 for our code. Never add a GPL dependency to the package; ffmpeg is fetched at run time.
- Git: workers never commit; the orchestrator commits on `claude/michelangelo-v1` (never `main`).
