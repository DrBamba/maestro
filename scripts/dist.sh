#!/usr/bin/env bash
#
# Produces the installables people are actually given.
#
#   npm run dist              # both
#   npm run dist -- mac       # just the .dmg
#   npm run dist -- linux     # just the .deb and .AppImage
#
# Everything lands in dist/.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

want_mac=no
want_linux=no

if [ "$#" -eq 0 ]; then
  want_mac=yes
  want_linux=yes
else
  for arg in "$@"; do
    case "$arg" in
      mac | macos | darwin | dmg) want_mac=yes ;;
      linux | ubuntu | deb) want_linux=yes ;;
      *)
        echo "dist: don't know how to build '$arg' — try 'mac' or 'linux'" >&2
        exit 2
        ;;
    esac
  done
fi

if [ "$want_mac" = yes ]; then
  echo "==> macOS"
  # Host architecture only. An Apple Silicon build does not run on an Intel Mac; that needs
  # `npx electron-builder --mac --x64`, which is a different artifact and a separate ask.
  npm run build
  npx electron-builder --mac
fi

if [ "$want_linux" = yes ]; then
  # x86_64 by default, unlike linux/test.sh, which follows the machine it is on. The two want
  # opposite things and the split is deliberate: testing wants the fast native build, while
  # anything handed to somebody else wants the architecture desktop Linux overwhelmingly is.
  # Building it on a Mac means emulation, so this is the slow half by a wide margin.
  arch="${ARCH:-amd64}"
  echo "==> Linux ($arch, in a container — Docker must be running)"
  ARCH="$arch" linux/test.sh dist
fi

echo
echo "==> dist/"
ls -lh dist/*.dmg dist/*.deb dist/*.AppImage 2>/dev/null | awk '{print "   ", $5, $9}' || true
