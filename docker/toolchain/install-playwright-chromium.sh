#!/usr/bin/env bash
set -euo pipefail

PLAYWRIGHT_BROWSER_INSTALL_VERSION="${PLAYWRIGHT_BROWSER_INSTALL_VERSION:-1.59.1}"
PLAYWRIGHT_CHROMIUM_LINK="${PLAYWRIGHT_CHROMIUM_LINK:-/usr/local/bin/playwright-chromium}"
PLAYWRIGHT_CACHE_DIR="${HOME}/.cache/ms-playwright"

# Install the same Chrome-for-Testing build path used by the devcontainer and
# CI browser tests. Explicitly using chrome-for-testing avoids Playwright's
# headless-shell-only download.
npx -y "playwright@${PLAYWRIGHT_BROWSER_INSTALL_VERSION}" install-deps chromium
npx -y "playwright@${PLAYWRIGHT_BROWSER_INSTALL_VERSION}" install chrome-for-testing

chromium_path="$(
  find "${PLAYWRIGHT_CACHE_DIR}"/chromium-*/chrome-linux* -type f -name chrome 2>/dev/null | head -1
)"

if [ -z "$chromium_path" ]; then
  echo "ERROR: Chromium not found under ${PLAYWRIGHT_CACHE_DIR}" >&2
  ls -laR "${PLAYWRIGHT_CACHE_DIR}/" >&2 || true
  exit 1
fi

ln -sf "$chromium_path" "$PLAYWRIGHT_CHROMIUM_LINK"

# Allow non-root users, like the devcontainer's vscode user, to launch the
# browser installed by root during image build.
if [ "$(id -u)" = "0" ] && [ "${HOME}" = "/root" ]; then
  chmod o+x /root /root/.cache /root/.cache/ms-playwright
  chmod -R o+rX /root/.cache/ms-playwright/
fi

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "AGENT_BROWSER_EXECUTABLE_PATH=$PLAYWRIGHT_CHROMIUM_LINK" >> "$GITHUB_ENV"
fi

"$PLAYWRIGHT_CHROMIUM_LINK" --version
