#!/usr/bin/env bash
#
# Prepares an Ubuntu container to run Maestro and then runs it.
#
# The checkout is mounted read-only at /src and copied to /work rather than used in place, because
# node_modules and out/ are built for the host's platform — a macOS node-pty in the tree would be
# the first thing to blow up. node_modules lives in a named volume so only the first run pays for
# downloading Electron.
set -euo pipefail

SRC=/src
WORK=/work

if [ ! -d "$SRC" ]; then
  echo "linux/entrypoint.sh: nothing mounted at $SRC — run this through linux/test.sh" >&2
  exit 2
fi

echo "==> syncing checkout into the container"
# .git is excluded deliberately: in a git worktree it is a file pointing at a path on the host that
# does not exist here, and nothing under test needs history.
tar -C "$SRC" -cf - \
  --exclude=./node_modules --exclude=./out --exclude=./dist --exclude=./.git \
  --exclude=./test-results --exclude=./playwright-report . \
  | tar -C "$WORK" -xf -

mkdir -p "$WORK/node_modules" /home/maestro/.cache
# Docker volumes come up owned by root on first use, and everything after this point runs as
# maestro — a cache it cannot write to fails the package build with its output already swallowed.
chown maestro:maestro "$WORK" "$WORK/node_modules" /home/maestro/.cache
chown -R maestro:maestro "$WORK" 2>/dev/null || true

as_maestro() {
  runuser -u maestro -- "$@"
}

echo "==> npm install (rebuilds node-pty against Linux Electron)"
as_maestro env HOME=/home/maestro npm install --no-audit --no-fund

# Chromium's sandbox does not work in here, and cannot be made to: Docker's default seccomp profile
# refuses the namespace calls the zygote needs, whatever the permissions on chrome-sandbox are. So
# everything below runs Chromium unsandboxed — a property of the container, not of Maestro on Linux.
# Playwright already passes --no-sandbox when it launches Electron, which is why the suite runs at
# all; the screenshot below has to ask for it explicitly. A real install has none of this problem:
# the .deb's postinst sets chrome-sandbox up at install time, which `dist` output can be checked for.

cd "$WORK"

run_x() {
  # -a picks a free display, so concurrent runs do not collide.
  as_maestro env HOME=/home/maestro PATH="$PATH" \
    xvfb-run -a --server-args="-screen 0 1600x1200x24" "$@"
}

case "${1:-e2e}" in
  e2e)
    shift || true
    echo "==> npm run e2e (under Xvfb)"
    run_x npm run e2e "$@"
    ;;
  build)
    echo "==> npm run build"
    as_maestro env HOME=/home/maestro npm run build
    ;;
  dist)
    # electron-builder directly, not `npm run dist`: that script now means "every platform", and
    # its Linux half is this container — so calling it here would have the container ask Docker to
    # start another one.
    echo "==> electron-builder --linux (AppImage + deb)"
    as_maestro env HOME=/home/maestro npm run build
    as_maestro env HOME=/home/maestro npx electron-builder --linux
    # Handed back rather than just listed. The container is thrown away when it exits, so a build
    # whose output stays inside it has produced nothing you can give anybody.
    if [ -d /out ]; then
      cp "$WORK"/dist/*.AppImage "$WORK"/dist/*.deb /out/ 2>/dev/null || true
      chown "$(stat -c '%u:%g' /out)" /out/* 2>/dev/null || true
      echo "==> delivered to dist/ on the host:"
      ls -la /out
    else
      echo "==> artifacts (inside the container only — mount /out to keep them):"
      ls -la "$WORK/dist" || true
    fi
    ;;
  app)
    echo "==> launching the app under Xvfb (no window will be visible)"
    as_maestro env HOME=/home/maestro npm run build
    run_x npm start
    ;;
  icon)
    # Rendered rather than committed blind: the SVG is the master and this is the one command that
    # turns it into the rasters electron-builder needs, so every PNG in the tree has a stated
    # provenance.
    #
    # A whole set, not one big file. Handed a single 1024px icon, electron-builder installs exactly
    # that and leaves the desktop to shrink it to 22px for a task list — which is both mushy and
    # wasteful. Each size is rendered from the vector instead, so the small ones are drawn rather
    # than downsampled. icon.png stays as well: it is what macOS's .icns is built from.
    echo "==> rendering the icon set from build/icon.svg"
    mkdir -p /out/icons
    for size in 16 24 32 48 64 128 256 512 1024; do
      rsvg-convert --width="$size" --height="$size" "$WORK/build/icon.svg" \
        --output "/out/icons/${size}x${size}.png"
    done
    cp /out/icons/1024x1024.png /out/icon.png
    # A bind mount on a Linux host comes up owned by root; on Docker Desktop this is already right.
    chown -R "$(stat -c '%u:%g' /out)" /out/icons /out/icon.png
    ls -l /out/icons /out/icon.png
    ;;
  screenshot)
    # The one thing the headless suite cannot assert. It drives the DOM, which is identical on both
    # platforms — so a window with the wrong chrome, or an 80px hole in the sidebar where macOS
    # traffic lights would go, passes every test in it. Here the app is started *shown*, against a
    # real X server, and the framebuffer is photographed.
    echo "==> building"
    as_maestro env HOME=/home/maestro npm run build

    echo "==> starting Xvfb on :99"
    as_maestro env HOME=/home/maestro Xvfb :99 -screen 0 1600x1040x24 >/dev/null 2>&1 &
    sleep 2

    # A bare X server draws no title bar — that is the window manager's job, and without one the
    # screenshot cannot show the very chrome this exists to check. Openbox is the smallest thing
    # that decorates a window; it is not GNOME, so the frame is plain, but it is a real frame in
    # the real place.
    as_maestro env HOME=/home/maestro DISPLAY=:99 openbox >/dev/null 2>&1 &
    sleep 1

    # Its own data directory, so the run is a dev profile and seeds the demo repos — a sidebar with
    # something in it says far more about the layout than an empty one.
    echo "==> launching the app"
    as_maestro env HOME=/home/maestro DISPLAY=:99 \
      MAESTRO_USER_DATA_DIR=/home/maestro/shot-profile \
      ./node_modules/.bin/electron out/main/index.js --no-sandbox >/tmp/app.log 2>&1 &

    # Electron has to finish painting before there is anything worth photographing.
    sleep "${SHOT_DELAY:-25}"

    echo "==> capturing"
    DISPLAY=:99 xwd -root -silent | convert xwd:- /out/linux-window.png
    chown "$(stat -c '%u:%g' /out)" /out/linux-window.png
    ls -l /out/linux-window.png
    echo "--- app log ---"
    tail -15 /tmp/app.log || true
    ;;
  shell)
    exec runuser -u maestro -- env HOME=/home/maestro bash
    ;;
  *)
    shift_cmd=("$@")
    echo "==> ${shift_cmd[*]}"
    run_x "${shift_cmd[@]}"
    ;;
esac
