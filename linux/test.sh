#!/usr/bin/env bash
#
# Runs Maestro on Ubuntu from a macOS (or Linux) checkout.
#
#   linux/test.sh              # build + the full e2e suite, under Xvfb
#   linux/test.sh build        # typecheck and build only — the quick check
#   linux/test.sh dist         # produce the AppImage and .deb into dist/
#   ARCH=amd64 linux/test.sh dist   # ...for an x86_64 machine, which most Linux desktops are
#   linux/test.sh icon         # re-render build/icon.png from build/icon.svg
#   linux/test.sh screenshot   # photograph the real Linux window — what the suite cannot assert
#   linux/test.sh shell        # a prompt inside the container, for poking at it
#   linux/test.sh npm run e2e -- --grep shell     # anything else, run under Xvfb
#
# Docker is the harness rather than a full VM because the thing that differs between macOS and
# Ubuntu here is the userland — the shell, the paths, the window toolkit, node-pty's build — and a
# container has all of that for real. `screenshot` covers how the window itself looks. What is left
# needs a desktop environment rather than a bare X server — the dock icon and its badge, launcher
# association, notifications — so for those, build a .deb with `dist` and install it on a VM.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Which Linux to be. The default follows this machine, which is what you want for testing; for a
# build to hand to somebody else it is almost always wrong — desktop Linux is overwhelmingly x86_64
# while an Apple Silicon Mac is arm64, and node-pty and Electron are both compiled per architecture.
#
#   ARCH=amd64 linux/test.sh dist
#
# amd64 on an arm64 host runs under emulation: correct, and severalfold slower.
ARCH="${ARCH:-$(uname -m)}"
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "unsupported ARCH: $ARCH (use amd64 or arm64)" >&2; exit 1 ;;
esac

# Per-architecture, so the two never overwrite each other's compiled node_modules — which is the
# failure that looks like a corrupted install rather than a wrong architecture.
IMAGE="maestro-linux:$ARCH"
VOLUME="maestro-linux-node-modules-$ARCH"
CACHE="maestro-linux-cache-$ARCH"

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop (or colima) and try again." >&2
  exit 1
fi

echo "==> building $IMAGE (linux/$ARCH)"
docker build --quiet --platform "linux/$ARCH" --tag "$IMAGE" "$REPO/linux" >/dev/null

# Both survive between runs, so only the first one pays: node_modules for Electron and node-pty,
# the cache for what electron-builder fetches at package time (fpm, the AppImage runtime, 7zip).
docker volume create "$VOLUME" >/dev/null
docker volume create "$CACHE" >/dev/null

# One array, appended to, never expanded while empty: macOS still ships bash 3.2, where "${a[@]}"
# on an empty array is an unbound-variable error under `set -u` and kills the script here.
args=(run --rm --platform "linux/$ARCH")

# A terminal only when there is one to attach — this has to run from CI and from an agent's shell
# as well as from a person's.
[ -t 0 ] && args+=(--interactive --tty)

# The checkout is mounted read-only, deliberately: nothing in the container should be able to edit
# the working tree. The commands whose whole purpose is to produce a file that belongs in it get
# somewhere writable to put it, and nothing else does.
case "${1:-}" in
  icon) args+=(--volume "$REPO/build:/out") ;;
  screenshot) args+=(--volume "$REPO/linux:/out") ;;
  dist) mkdir -p "$REPO/dist"; args+=(--volume "$REPO/dist:/out") ;;
esac

args+=(
  --volume "$REPO:/src:ro"
  --volume "$VOLUME:/work/node_modules"
  --volume "$CACHE:/home/maestro/.cache"
  --init
  "$IMAGE"
)

exec docker "${args[@]}" "$@"
