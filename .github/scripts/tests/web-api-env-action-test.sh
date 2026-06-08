#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ACTION="${REPO_ROOT}/.github/actions/web-api-env/action.yml"
TEMP_DIRS=()

cleanup() {
  if [[ "${#TEMP_DIRS[@]}" -gt 0 ]]; then
    rm -rf "${TEMP_DIRS[@]}"
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local output="$1"
  local expected="$2"
  if [[ "$output" != *"$expected"* ]]; then
    fail "expected output to contain: ${expected}"
  fi
}

assert_env_value() {
  local env_file="$1"
  local key="$2"
  local expected="$3"
  local value
  value="$(awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; found = 1 } END { if (!found) exit 1 }' "$env_file")" ||
    fail "expected ${key} in ${env_file}"
  if [[ "$value" != "$expected" ]]; then
    fail "expected ${key}=${expected}, got ${value}"
  fi
}

assert_env_absent_value() {
  local env_file="$1"
  local unexpected="$2"
  if grep -Fq "$unexpected" "$env_file"; then
    fail "did not expect rendered env to contain ${unexpected}"
  fi
}

extract_action_script() {
  awk '
    /^      run: \|$/ {
      in_run = 1
      next
    }
    in_run && /^        / {
      sub(/^        /, "")
      print
      next
    }
    in_run && /^$/ {
      print
      next
    }
    in_run {
      exit
    }
  ' "$ACTION"
}

oauth_client_config_prefixes() {
  awk '
    /^        oauth_client_config_prefixes=\($/ {
      in_list = 1
      next
    }
    in_list && /^        \)$/ {
      exit
    }
    in_list {
      sub(/^        /, "")
      gsub(/[[:space:]]/, "")
      if ($0 != "") {
        print
      }
    }
  ' "$ACTION"
}

oauth_client_config_keys() {
  local prefix
  while IFS= read -r prefix; do
    printf '%s_OAUTH_CLIENT_ID\n' "$prefix"
    printf '%s_OAUTH_CLIENT_SECRET\n' "$prefix"
  done <<< "$(oauth_client_config_prefixes)"
}

build_doppler_secrets_json() {
  local omit_key="${1:-}"
  local json="{}"
  local key
  while IFS= read -r key; do
    if [[ "$key" == "$omit_key" ]]; then
      continue
    fi
    json="$(jq -c --arg key "$key" --arg value "doppler-${key}" '. + {($key): $value}' <<< "$json")"
  done <<< "$(oauth_client_config_keys)"
  printf '%s' "$json"
}

run_action() {
  local doppler_secrets_json="$1"
  local test_dir="$2"
  local input_app="${3:-api}"
  local input_environment="${4:-preview}"
  local action_script="${test_dir}/web-api-env-action.sh"
  local github_output="${test_dir}/github-output"

  extract_action_script > "$action_script"

  env \
    RUNNER_TEMP="$test_dir" \
    GITHUB_OUTPUT="$github_output" \
    GITHUB_SHA="test-sha" \
    INPUT_APP="$input_app" \
    INPUT_ENVIRONMENT="$input_environment" \
    INPUT_DATABASE_URL="postgres://preview-db" \
    INPUT_JOB_REF="pr-123" \
    INPUT_WEB_URL="https://pr-123-www.vm0.test" \
    INPUT_APP_URL="https://pr-123-app.vm0.test" \
    INPUT_API_URL="https://pr-123-api.vm0.test" \
    INPUT_API_BACKEND_URL="https://pr-123-api-backend.vm0.test" \
    REPO_VARS_JSON='{"GH_OAUTH_CLIENT_ID":"github-gh-client-id","SLACK_OAUTH_CLIENT_ID":"github-slack-client-id","VM0_API_URL":"https://api.github.test","GOOGLE_ADS_DEVELOPER_TOKEN":"github-google-ads-var","FINICITY_PARTNER_ID":"github-finicity-partner-id","POSTHOG_KEY":"github-posthog-key","POSTHOG_HOST":"https://posthog.github.test"}' \
    REPO_SECRETS_JSON='{"GH_OAUTH_CLIENT_SECRET":"github-gh-client-secret","SLACK_OAUTH_CLIENT_SECRET":"github-slack-client-secret","GOOGLE_ADS_DEVELOPER_TOKEN":"github-google-ads-secret","FINICITY_APP_KEY":"github-finicity-app-key","FINICITY_APP_SECRET":"github-finicity-app-secret"}' \
    DOPPLER_SECRETS_JSON="$doppler_secrets_json" \
    bash "$action_script"
}

if grep -En 'add_(var|secret) [A-Z0-9_]+_OAUTH_CLIENT_(ID|SECRET)' "$ACTION"; then
  fail "OAuth client id/secret entries must come from Doppler, not GitHub vars or secrets"
fi

if ! oauth_client_config_prefixes | grep -qx SLACK; then
  fail "expected Slack OAuth client config to come from Doppler"
fi

success_dir="$(mktemp -d)"
TEMP_DIRS+=("$success_dir")
success_output="$(run_action "$(build_doppler_secrets_json)" "$success_dir")"
success_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${success_dir}/github-output")"
assert_contains "$success_output" "Rendered"
assert_env_value "$success_env_file" GH_OAUTH_CLIENT_ID "doppler-GH_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" GH_OAUTH_CLIENT_SECRET "doppler-GH_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" SLACK_OAUTH_CLIENT_ID "doppler-SLACK_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" SLACK_OAUTH_CLIENT_SECRET "doppler-SLACK_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" GOOGLE_ADS_DEVELOPER_TOKEN "github-google-ads-secret"
assert_env_value "$success_env_file" FINICITY_APP_KEY "github-finicity-app-key"
assert_env_value "$success_env_file" FINICITY_APP_SECRET "github-finicity-app-secret"
assert_env_value "$success_env_file" FINICITY_PARTNER_ID "github-finicity-partner-id"
assert_env_absent_value "$success_env_file" "github-gh-client-id"
assert_env_absent_value "$success_env_file" "github-gh-client-secret"
assert_env_absent_value "$success_env_file" "github-slack-client-id"
assert_env_absent_value "$success_env_file" "github-slack-client-secret"
assert_env_absent_value "$success_env_file" "github-posthog-key"

production_web_dir="$(mktemp -d)"
TEMP_DIRS+=("$production_web_dir")
production_web_output="$(run_action "$(build_doppler_secrets_json)" "$production_web_dir" web production)"
production_web_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${production_web_dir}/github-output")"
assert_contains "$production_web_output" "Rendered"
assert_env_value "$production_web_env_file" POSTHOG_KEY "github-posthog-key"
assert_env_value "$production_web_env_file" POSTHOG_HOST "https://posthog.github.test"

missing_dir="$(mktemp -d)"
TEMP_DIRS+=("$missing_dir")
status=0
missing_output="$(run_action "$(build_doppler_secrets_json GH_OAUTH_CLIENT_SECRET)" "$missing_dir" 2>&1)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing Doppler OAuth client config to fail"
fi
assert_contains "$missing_output" "::error::GH_OAUTH_CLIENT_SECRET is missing from Doppler OAuth config"

echo "web-api-env-action-test: ok"
