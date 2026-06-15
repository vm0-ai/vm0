#!/usr/bin/env bash
set -euo pipefail

PLAYWRIGHT_BROWSER_INSTALL_VERSION="${PLAYWRIGHT_BROWSER_INSTALL_VERSION:-1.59.1}"
PLAYWRIGHT_CHROMIUM_LINK="${PLAYWRIGHT_CHROMIUM_LINK:-/usr/local/bin/playwright-chromium}"
BROWSER_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-${HOME:-/root}/.cache/ms-playwright}"

# Keep CI's explicit browser install aligned with the E2E Playwright command.
npx -y "playwright@${PLAYWRIGHT_BROWSER_INSTALL_VERSION}" install --with-deps chromium

chromium_path="$(
  { find "$BROWSER_CACHE" -path "*/chrome-linux*/chrome" -type f -print 2>/dev/null || true; } \
    | sort -V \
    | tail -1
)"

if [ -z "$chromium_path" ]; then
  echo "ERROR: Chromium not found under $BROWSER_CACHE" >&2
  ls -laR "$BROWSER_CACHE" >&2 || true
  exit 1
fi

link_dir="$(dirname "$PLAYWRIGHT_CHROMIUM_LINK")"
if ! { mkdir -p "$link_dir" && ln -sf "$chromium_path" "$PLAYWRIGHT_CHROMIUM_LINK"; } 2>/dev/null; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo mkdir -p "$link_dir"
    sudo ln -sf "$chromium_path" "$PLAYWRIGHT_CHROMIUM_LINK"
  else
    PLAYWRIGHT_CHROMIUM_LINK="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/playwright-chromium"
    ln -sf "$chromium_path" "$PLAYWRIGHT_CHROMIUM_LINK"
  fi
fi

chmod o+x "${HOME:-/root}" "${HOME:-/root}/.cache" "$BROWSER_CACHE" 2>/dev/null || true
chmod -R o+rX "$BROWSER_CACHE" 2>/dev/null || true

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "AGENT_BROWSER_EXECUTABLE_PATH=$PLAYWRIGHT_CHROMIUM_LINK" >> "$GITHUB_ENV"
fi

"$PLAYWRIGHT_CHROMIUM_LINK" --version
