#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "${repo_root}/e2e/helpers/browser.bash"

mode=""
open_count=0
last_open_url=""
page_host=""
page_status=0
page_title=""
page_body=""

agent-browser() {
  local command="${1:?agent-browser command is required}"
  shift

  case "$command" in
    open)
      last_open_url="${1:?browser URL is required}"
      ((open_count += 1))
      case "$mode" in
        transient)
          if (( open_count < 3 )); then
            page_host="e16a8983.okou-app.pages.dev"
            page_status=404
            page_title="Deployment Not Found"
            page_body="Nothing is here yet"
          else
            page_host="e16a8983.okou-app.pages.dev"
            page_status=200
            page_title="VM0"
            page_body=""
          fi
          ;;
        application-404)
          page_host="e16a8983.okou-app.pages.dev"
          page_status=404
          page_title="VM0"
          page_body="Page not found"
          ;;
        mutable-host-404)
          page_host="pr-25738-app.okou-app.pages.dev"
          page_status=404
          page_title="Deployment Not Found"
          page_body="Nothing is here yet"
          ;;
        persistent)
          page_host="e16a8983.okou-app.pages.dev"
          page_status=404
          page_title="Deployment Not Found"
          page_body="Nothing is here yet"
          ;;
        *)
          echo "unknown fake browser mode: ${mode}" >&2
          return 1
          ;;
      esac
      ;;
    eval)
      PAGE_HOST="$page_host" \
        PAGE_STATUS="$page_status" \
        PAGE_TITLE="$page_title" \
        PAGE_BODY="$page_body" \
        JS_EXPRESSION="${1:?JavaScript expression is required}" \
        node <<'NODE'
globalThis.location = { hostname: process.env.PAGE_HOST };
globalThis.performance = {
  getEntriesByType: (type) =>
    type === "navigation"
      ? [{ responseStatus: Number(process.env.PAGE_STATUS) }]
      : [],
};
globalThis.document = {
  title: process.env.PAGE_TITLE,
  body: { innerText: process.env.PAGE_BODY },
};

process.stdout.write(String(eval(process.env.JS_EXPRESSION)));
NODE
      ;;
    *)
      echo "unexpected agent-browser command: ${command}" >&2
      return 1
      ;;
  esac
}

assert_equal() {
  local expected="$1"
  local actual="$2"
  local description="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "${description}: expected ${expected}, got ${actual}" >&2
    exit 1
  fi
}

target_url="https://e16a8983.okou-app.pages.dev/sign-up"

sleep() {
  SECONDS=$((SECONDS + 2))
}

mode="transient"
open_count=0
open_browser_with_pages_deployment_retry "$target_url" >/dev/null 2>&1
assert_equal "3" "$open_count" "transient deployment 404 retry count"
assert_equal "$target_url" "$last_open_url" "retried navigation URL"

mode="application-404"
open_count=0
open_browser_with_pages_deployment_retry "$target_url" >/dev/null 2>&1
assert_equal "1" "$open_count" "application 404 navigation count"

mode="mutable-host-404"
open_count=0
open_browser_with_pages_deployment_retry "$target_url" >/dev/null 2>&1
assert_equal "1" "$open_count" "mutable host deployment 404 navigation count"

mode="persistent"
open_count=0
SECONDS=0
error_output="$(mktemp)"
trap 'rm -f "$error_output"' EXIT
if open_browser_with_pages_deployment_retry "$target_url" \
  >/dev/null 2>"$error_output"; then
  echo "persistent deployment 404 must fail" >&2
  exit 1
fi
assert_equal "31" "$open_count" "persistent deployment 404 retry count"
if ! grep -Fq \
  "Cloudflare Pages deployment remained unavailable after 60 seconds" \
  "$error_output"; then
  echo "persistent deployment 404 must report the bounded retry failure" >&2
  exit 1
fi

echo "browser-pages-deployment-recovery tests passed"
