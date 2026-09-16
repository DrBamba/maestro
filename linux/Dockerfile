# Ubuntu 24.04 as a user would actually have it, so a Linux regression fails here rather than on
# someone's laptop. Nothing is stubbed: the suite launches the real Electron app, with real PTYs
# and a real X server, against the same `out/` build that ships.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Five groups, and it is worth keeping them apart — when the app fails to start on a Linux box the
# missing piece is almost always from the third group, and the error names the library.
#   fetching node · compiling node-pty · opening a window · rendering the app icon and
#   photographing the window · what Maestro shells out to
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils \
      build-essential python3 \
      xvfb dbus-x11 fonts-dejavu-core \
      librsvg2-bin imagemagick x11-apps openbox \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libcairo2 libcups2t64 libdrm2 \
      libgbm1 libgtk-3-0t64 libnspr4 libnss3 libpango-1.0-0 libxcomposite1 libxdamage1 \
      libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 libxtst6 \
      git \
  && rm -rf /var/lib/apt/lists/*

# From nodejs.org rather than apt: Ubuntu's own nodejs is far behind, and pinning the version here
# means the container and the developer's machine are not silently on different runtimes.
ARG NODE_VERSION=24.14.1
RUN case "$(dpkg --print-architecture)" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 --wildcards --no-anchored --exclude='*.md' --exclude='LICENSE'

# Chromium will not run as root, and a normal user is what the app actually ships to. The entrypoint
# starts as root only long enough to fix up the sandbox binary, then drops to this account.
RUN useradd --create-home --shell /bin/bash maestro
WORKDIR /work

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["e2e"]
