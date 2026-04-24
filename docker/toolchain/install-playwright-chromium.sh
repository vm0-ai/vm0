#!/usr/bin/env bash
set -euo pipefail

PLAYWRIGHT_BROWSER_INSTALL_VERSION="${PLAYWRIGHT_BROWSER_INSTALL_VERSION:-1.59.1}"
PLAYWRIGHT_CHROMIUM_LINK="${PLAYWRIGHT_CHROMIUM_LINK:-/usr/local/bin/playwright-chromium}"

# Install the same Chrome-for-Testing build path used by the devcontainer and
# CI browser tests. Explicitly using chrome-for-testing avoids Playwright's
# headless-shell-only download.
npx -y "playwright@${PLAYWRIGHT_BROWSER_INSTALL_VERSION}" install-deps chromium
npx -y "playwright@${PLAYWRIGHT_BROWSER_INSTALL_VERSION}" install chrome-for-testing

chromium_path="$(
  find /root/.cache/ms-playwright/chromium-*/chrome-linux* -type f -name chrome 2>/dev/null | head -1
)"

if [ -z "$chromium_path" ]; then
  echo "ERROR: Chromium not found under /root/.cache/ms-playwright" >&2
  ls -laR /root/.cache/ms-playwright/ >&2 || true
  exit 1
fi

ln -sf "$chromium_path" "$PLAYWRIGHT_CHROMIUM_LINK"

# Allow non-root users, like the devcontainer's vscode user, to launch the
# browser installed by root during image build.
chmod o+x /root /root/.cache /root/.cache/ms-playwright
chmod -R o+rX /root/.cache/ms-playwright/

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "AGENT_BROWSER_EXECUTABLE_PATH=$PLAYWRIGHT_CHROMIUM_LINK" >> "$GITHUB_ENV"
fi

"$PLAYWRIGHT_CHROMIUM_LINK" --version
