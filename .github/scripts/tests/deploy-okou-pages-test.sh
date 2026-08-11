#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/deploy-okou-pages.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

pages_dist="${tmp_dir}/pages dist"
mkdir -p "$pages_dist" "${tmp_dir}/bin"

cat >"${tmp_dir}/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

expected_args=(
  --dir "${MOCK_REPO_ROOT}/turbo"
  --filter @vm0/host-worker
  exec wrangler pages deploy "$EXPECTED_PAGES_DIST"
  --project-name "$EXPECTED_PROJECT_NAME"
  --branch "$EXPECTED_BRANCH"
  --commit-hash "$EXPECTED_COMMIT_SHA"
  --commit-dirty=false
)

if (( $# != ${#expected_args[@]} )); then
  echo "unexpected pnpm argument count: $#" >&2
  exit 2
fi
for ((index = 0; index < ${#expected_args[@]}; index++)); do
  position=$((index + 1))
  if [[ "${!position}" != "${expected_args[$index]}" ]]; then
    echo "unexpected pnpm argument ${position}" >&2
    exit 2
  fi
done

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID was not forwarded}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN was not forwarded}"

attempt="$(<"$MOCK_PNPM_STATE_FILE")"
attempt=$((attempt + 1))
printf '%s\n' "$attempt" >"$MOCK_PNPM_STATE_FILE"

if [[ -n "${WRANGLER_OUTPUT_FILE_PATH:-}" ]]; then
  printf '{"type":"wrangler-session","attempt":%s}\n' "$attempt" \
    >>"$WRANGLER_OUTPUT_FILE_PATH"
fi

if (( attempt <= MOCK_PNPM_FAILURES )); then
  if [[ -n "${WRANGLER_OUTPUT_FILE_PATH:-}" ]]; then
    printf '{"type":"command-failed","attempt":%s}\n' "$attempt" \
      >>"$WRANGLER_OUTPUT_FILE_PATH"
  fi
  exit 17
fi

if [[ -n "${WRANGLER_OUTPUT_FILE_PATH:-}" ]]; then
  printf '{"type":"pages-deploy-detailed","attempt":%s}\n' "$attempt" \
    >>"$WRANGLER_OUTPUT_FILE_PATH"
fi
EOF

cat >"${tmp_dir}/bin/sleep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${1:?sleep delay is required}" >>"$MOCK_SLEEP_LOG"
EOF

chmod +x "${tmp_dir}/bin/pnpm" "${tmp_dir}/bin/sleep"

export PATH="${tmp_dir}/bin:${PATH}"
export CLOUDFLARE_ACCOUNT_ID="test-account"
export CLOUDFLARE_API_TOKEN="test-token"
export EXPECTED_BRANCH="pr-26218-app"
export EXPECTED_COMMIT_SHA="0123456789abcdef0123456789abcdef01234567"
export EXPECTED_PAGES_DIST="$pages_dist"
export EXPECTED_PROJECT_NAME="okou-app"
export MOCK_PNPM_STATE_FILE="${tmp_dir}/pnpm-state"
export MOCK_REPO_ROOT="$repo_root"
export MOCK_SLEEP_LOG="${tmp_dir}/sleep.log"

reset_attempts() {
  printf '0\n' >"$MOCK_PNPM_STATE_FILE"
  : >"$MOCK_SLEEP_LOG"
}

run_deploy() {
  bash "$script" \
    "$pages_dist" \
    "$EXPECTED_PROJECT_NAME" \
    "$EXPECTED_BRANCH" \
    "$EXPECTED_COMMIT_SHA"
}

reset_attempts
MOCK_PNPM_FAILURES=0 run_deploy >/dev/null
[[ "$(<"$MOCK_PNPM_STATE_FILE")" == "1" ]]
[[ ! -s "$MOCK_SLEEP_LOG" ]]

reset_attempts
output_file="${tmp_dir}/wrangler-output.ndjson"
printf '{"type":"stale"}\n' >"$output_file"
WRANGLER_OUTPUT_FILE_PATH="$output_file" \
  MOCK_PNPM_FAILURES=2 \
  run_deploy >/dev/null 2>&1
[[ "$(<"$MOCK_PNPM_STATE_FILE")" == "3" ]]
grep -Fxq '5' "$MOCK_SLEEP_LOG"
grep -Fxq '10' "$MOCK_SLEEP_LOG"
[[ "$(wc -l <"$MOCK_SLEEP_LOG")" == "2" ]]
grep -Fq '"type":"pages-deploy-detailed","attempt":3' "$output_file"
if grep -Eq 'stale|command-failed|"attempt":[12]' "$output_file"; then
  echo "Wrangler output retained a previous attempt" >&2
  exit 1
fi

reset_attempts
printf '{"type":"stale"}\n' >"$output_file"
if WRANGLER_OUTPUT_FILE_PATH="$output_file" \
  MOCK_PNPM_FAILURES=99 \
  run_deploy >/dev/null 2>"${tmp_dir}/exhausted.stderr"; then
  echo "expected an exhausted deployment to fail" >&2
  exit 1
else
  status=$?
fi
[[ "$status" == "17" ]]
[[ "$(<"$MOCK_PNPM_STATE_FILE")" == "3" ]]
[[ "$(wc -l <"$MOCK_SLEEP_LOG")" == "2" ]]
grep -Fq '"type":"command-failed","attempt":3' "$output_file"
if grep -Eq 'stale|"attempt":[12]' "$output_file"; then
  echo "final Wrangler output retained an earlier attempt" >&2
  exit 1
fi
grep -Fq 'failed after 3 attempts' "${tmp_dir}/exhausted.stderr"

if bash "$script" "$pages_dist" okou-app production >/dev/null 2>&1; then
  echo "expected a missing argument to fail" >&2
  exit 1
fi

if bash "$script" \
  "${tmp_dir}/missing" \
  okou-app \
  production \
  "$EXPECTED_COMMIT_SHA" >/dev/null 2>&1; then
  echo "expected a missing distribution to fail" >&2
  exit 1
fi

if (
  unset CLOUDFLARE_API_TOKEN
  run_deploy >/dev/null 2>&1
); then
  echo "expected a missing Cloudflare token to fail" >&2
  exit 1
fi

echo "deploy-okou-pages tests passed"
