#!/usr/bin/env bash
# Install Michelangelo (the `mgl` CLI and the `michelangelo` library) from GitHub.
#
#   curl -fsSL https://raw.githubusercontent.com/samsam32118/Michelangelo/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/samsam32118/Michelangelo/main/install.sh | bash -s -- --skill
#
# Options (flags or environment variables):
#   --ref <git ref>    MGL_REF        branch, tag or commit to install (default: main)
#   --dir <path>       MGL_DIR        where the source is kept (default: ~/.local/share/michelangelo/src)
#   --skill            MGL_SKILL=1    also install the agent skill to ~/.claude/skills/michelangelo/
#   --no-ffmpeg        MGL_NO_FFMPEG=1  do not download the pinned ffmpeg build (use your own; see `mgl doctor`)
#
# Running it again updates an existing install. Requires git and Node.js >= 22.
set -euo pipefail

REPO_URL="${MGL_REPO:-https://github.com/samsam32118/Michelangelo.git}"
REF="${MGL_REF:-main}"
DIR="${MGL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/michelangelo/src}"
SKILL="${MGL_SKILL:-0}"
NO_FFMPEG="${MGL_NO_FFMPEG:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --skill) SKILL=1; shift ;;
    --no-ffmpeg) NO_FFMPEG=1; shift ;;
    -h|--help) echo "usage: install.sh [--ref <git ref>] [--dir <path>] [--skill] [--no-ffmpeg]"; exit 0 ;;
    *) echo "install.sh: unknown option $1 (try --help)" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# 1. prerequisites
command -v git >/dev/null || die "git is required. fix: install git, then run this again."
command -v node >/dev/null || die "Node.js >= 22 is required. fix: install it from https://nodejs.org (or: nvm install 22)."
command -v npm >/dev/null || die "npm is required (it ships with Node.js)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js $(node -v) is too old; Michelangelo needs >= 22. fix: nvm install 22"

# 2. source
if [ -d "$DIR/.git" ]; then
  say "Updating $DIR to $REF"
  git -C "$DIR" fetch --quiet --depth 1 origin "$REF"
  git -C "$DIR" checkout --quiet --force FETCH_HEAD
else
  say "Cloning $REPO_URL ($REF) into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$DIR" 2>/dev/null || {
    # a commit sha cannot be cloned with --branch
    rm -rf "$DIR"; git init --quiet "$DIR"
    git -C "$DIR" remote add origin "$REPO_URL"
    git -C "$DIR" fetch --quiet --depth 1 origin "$REF"
    git -C "$DIR" checkout --quiet FETCH_HEAD
  }
fi

# 3. build and pack
say "Building (npm ci + tsc)"
(cd "$DIR" && npm ci --no-audit --no-fund --loglevel=error && npm run --silent build >/dev/null)
TGZ="$(cd "$DIR" && npm pack --silent | tail -n 1)"

# 4. install the CLI globally (falls back to ~/.local when the global prefix is not writable)
PREFIX="$(npm prefix -g)"
if [ -w "$PREFIX/lib" ] || [ -w "$PREFIX" ]; then
  say "Installing mgl into $PREFIX"
  npm install -g --no-audit --no-fund --loglevel=error "$DIR/$TGZ"
else
  PREFIX="$HOME/.local"
  say "Installing mgl into $PREFIX (the global npm prefix is not writable)"
  npm install -g --prefix "$PREFIX" --no-audit --no-fund --loglevel=error "$DIR/$TGZ"
fi
rm -f "$DIR/$TGZ"
MGL="$PREFIX/bin/mgl"
[ -x "$MGL" ] || MGL="$(command -v mgl || true)"
[ -n "$MGL" ] || die "mgl was installed but is not on PATH. fix: add $PREFIX/bin to PATH."

# 5. ffmpeg (pinned, checksummed, cached in ~/.cache/michelangelo)
if [ "$NO_FFMPEG" = "1" ]; then
  "$MGL" doctor || true
else
  say "Checking ffmpeg (downloads the pinned build if needed)"
  "$MGL" doctor --fetch || true
fi

# 6. optional: the agent skill for Claude Code
if [ "$SKILL" = "1" ]; then
  SKILL_DIR="$HOME/.claude/skills/michelangelo"
  mkdir -p "$SKILL_DIR"
  cp "$DIR/SKILL.md" "$SKILL_DIR/SKILL.md"
  say "Agent skill installed: $SKILL_DIR/SKILL.md"
fi

say "Done: $("$MGL" --version)"
case ":$PATH:" in *":$PREFIX/bin:"*) ;; *) echo "Add to your shell profile: export PATH=\"$PREFIX/bin:\$PATH\"" ;; esac
echo "Try: mgl new shorts --script script.txt   (then mgl look, mgl render)"
