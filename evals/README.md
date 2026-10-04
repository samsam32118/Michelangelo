# Evals

`node evals/run.mjs` runs an eval set: each task in a fresh directory outside the repository, an agent working
with the packed library, then the task's graders. Task sets: `evals/tasks` (the main set, see
[tasks/README.md](tasks/README.md)) and the held-out sets `evals/heldout*`, which builders never open (CLAUDE.md).
`node evals/report.mjs <results dir>` rebuilds a summary; `HISTORY.md` has one row per run. The isolation design is
DESIGN.md §16.1; this page records how the held-out hygiene and the audit work today.

## Held-out aliases

A held-out task is never named by its id in anything public. Its alias is `h-<6 hex>`: the first 6 hex digits of
HMAC-SHA256 of the id, keyed by a random secret in `<privateDir>/alias-key` (default
`/root/mgl-eval-private/alias-key`, or `$MGL_EVAL_PRIVATE_DIR`; `--private-dir` overrides it). The key is created
on first use with mode 0600 (its directory 0700) and never lives in the repository, so a guessed id cannot be
confirmed by hashing it. Deleting the key makes a new one and changes every alias.

All aliases were regenerated with a key on 2026-10-04. Earlier public summaries in git history still use the old
unsalted aliases (a plain sha256 prefix, which can confirm a guessed id) for `heldout2`, and real ids for the
first `heldout` set, which is already exposed and now serves as a regression set. Only a history rewrite would
remove them.

## Public and private results

- Public held-out results (`evals/results/<label>/heldout*/`: `result.json`, `summary.json`, `summary.md`) carry
  only aliases and counts: no task ids, prompts, check names or transcripts. `writeSummary` refuses to write a
  held-out summary with a result that is not named by an alias.
- `report.mjs` treats any `heldout\d*` results dir outside the private dir as public: it names tasks by their
  directory (the alias) and scrubs old `result.json` files in place.
- Private results (transcripts, check details) live in `<privateDir>/<label>/<set>/<task>`. Existing labels were
  migrated there.

## The agent's allowlist

The agent runs `claude -p` in the default permission mode with an allowlist of file tools and a few commands
(`npx`, `mgl`, `node`, `npm`, `ffmpeg`, `ffprobe` and plain file commands). It holds no command runners: `env`,
`xargs` and `find` were removed, and `bash` and `sh` were never in it (see `COMMAND_RUNNERS` in `evals/run.mjs`).
Some allowed commands can still run others (`awk` with `system()`, `sed`'s `e` command, `node -e`,
`python3 -c`, `npx -c`); those are audited, not blocked: their text is scanned for fatal paths, and the sandbox
user is the barrier.

## Audit rules

Every tool call is checked after the run:

- `cd` is followed within a Bash call and across calls; Claude Code's "Shell cwd was reset" message resets it.
- Wrappers are seen through, including `sh -c '...'`. Relative operands of file commands are resolved against the
  current directory.
- `rm`, `mv`, `cp` and `ln` operands outside the run dir are violations.
- Accesses to the repository, `evals/`, the private dir (where the grader files are stashed), the results dir,
  other sandboxes or other scratchpads are fatal and fail the run, as is any command whose text names one of
  those paths.
