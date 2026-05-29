#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY="${SCRIPT_DIR}/verify-doppler-oauth-config.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local output=$1 expected=$2
  if [[ "$output" != *"$expected"* ]]; then
    fail "expected output to contain: ${expected}"
  fi
}

assert_not_contains() {
  local output=$1 unexpected=$2
  if [[ "$output" == *"$unexpected"* ]]; then
    fail "expected output not to contain: ${unexpected}"
  fi
}

without_mask_commands() {
  grep -v '^::add-mask::' <<< "$1" || true
}

run_verifier() {
  local env_args=(
    "PATH=${PATH}"
    "GITHUB_ACTIONS=${GITHUB_ACTIONS:-}"
    "DOPPLER_PROJECT=vm0"
    "DOPPLER_CONFIG=dev"
    "EXPECTED_KEYS=${EXPECTED_KEYS:-}"
  )
  local optional_names=(
    AIRTABLE_OAUTH_CLIENT_SECRET
    GH_OAUTH_CLIENT_SECRET
    GOOGLE_OAUTH_CLIENT_ID
    GOOGLE_OAUTH_CLIENT_SECRET
    SLACK_OAUTH_CLIENT_SECRET
    X_OAUTH_CLIENT_ID
    X_OAUTH_CLIENT_SECRET
    REPOSITORY_SECRET_AIRTABLE_OAUTH_CLIENT_SECRET
    REPOSITORY_SECRET_GH_OAUTH_CLIENT_SECRET
    REPOSITORY_VAR_GOOGLE_OAUTH_CLIENT_ID
    REPOSITORY_SECRET_GOOGLE_OAUTH_CLIENT_SECRET
    REPOSITORY_SECRET_SLACK_OAUTH_CLIENT_SECRET
    REPOSITORY_VAR_X_OAUTH_CLIENT_ID
    REPOSITORY_SECRET_X_OAUTH_CLIENT_SECRET
  )
  local name
  for name in "${optional_names[@]}"; do
    if [[ -v "$name" ]]; then
      env_args+=("${name}=${!name}")
    fi
  done

  env -i "${env_args[@]}" "$VERIFY"
}

success_output="$(
  EXPECTED_KEYS=$'GOOGLE_OAUTH_CLIENT_ID\nGOOGLE_OAUTH_CLIENT_SECRET\nSLACK_OAUTH_CLIENT_SECRET' \
    GOOGLE_OAUTH_CLIENT_ID=shared-google-client-id \
    REPOSITORY_VAR_GOOGLE_OAUTH_CLIENT_ID=shared-google-client-id \
    GOOGLE_OAUTH_CLIENT_SECRET=shared-google-secret \
    REPOSITORY_SECRET_GOOGLE_OAUTH_CLIENT_SECRET=shared-google-secret \
    SLACK_OAUTH_CLIENT_SECRET=shared-slack-secret \
    REPOSITORY_SECRET_SLACK_OAUTH_CLIENT_SECRET=shared-slack-secret \
    run_verifier
)"
assert_contains "$success_output" "ok: GOOGLE_OAUTH_CLIENT_ID"
assert_contains "$success_output" "ok: GOOGLE_OAUTH_CLIENT_SECRET"
assert_contains "$success_output" "ok: SLACK_OAUTH_CLIENT_SECRET"
assert_contains "$success_output" "Checked 3 vm0/dev OAuth client config entries (3 compared, 0 warning(s))"
success_log_output="$(without_mask_commands "$success_output")"
assert_not_contains "$success_log_output" "shared-google-client-id"
assert_not_contains "$success_log_output" "shared-google-secret"
assert_not_contains "$success_log_output" "shared-slack-secret"

warning_output="$(
  EXPECTED_KEYS=X_OAUTH_CLIENT_ID \
    X_OAUTH_CLIENT_ID=doppler-x-client-id \
    run_verifier 2>&1
)"
assert_contains "$warning_output" "::warning::X_OAUTH_CLIENT_ID is missing from GitHub variables; Doppler has a value"
assert_contains "$warning_output" "Checked 1 vm0/dev OAuth client config entries (0 compared, 1 warning(s))"
assert_not_contains "$warning_output" "missing from Doppler"
warning_log_output="$(without_mask_commands "$warning_output")"
assert_not_contains "$warning_log_output" "doppler-x-client-id"

status=0
missing_both_output="$(
  EXPECTED_KEYS=X_OAUTH_CLIENT_SECRET \
    run_verifier 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing GitHub and missing Doppler case to fail"
fi
assert_contains "$missing_both_output" "X_OAUTH_CLIENT_SECRET is missing from Doppler (vm0/dev)"
assert_contains "$missing_both_output" "1 OAuth client config comparison(s) failed"
assert_not_contains "$missing_both_output" "missing from GitHub secrets"

status=0
missing_doppler_output="$(
  EXPECTED_KEYS=X_OAUTH_CLIENT_SECRET \
    REPOSITORY_SECRET_X_OAUTH_CLIENT_SECRET=github-x-secret \
    run_verifier 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected GitHub-present, Doppler-missing case to fail"
fi
assert_contains "$missing_doppler_output" "X_OAUTH_CLIENT_SECRET is missing from Doppler (vm0/dev)"
assert_contains "$missing_doppler_output" "1 OAuth client config comparison(s) failed"
missing_doppler_log_output="$(without_mask_commands "$missing_doppler_output")"
assert_not_contains "$missing_doppler_log_output" "github-x-secret"

status=0
empty_doppler_output="$(
  EXPECTED_KEYS=AIRTABLE_OAUTH_CLIENT_SECRET \
    AIRTABLE_OAUTH_CLIENT_SECRET= \
    REPOSITORY_SECRET_AIRTABLE_OAUTH_CLIENT_SECRET=github-airtable-secret \
    run_verifier 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected empty Doppler case to fail"
fi
assert_contains "$empty_doppler_output" "AIRTABLE_OAUTH_CLIENT_SECRET is empty in Doppler (vm0/dev)"
assert_contains "$empty_doppler_output" "1 OAuth client config comparison(s) failed"
empty_doppler_log_output="$(without_mask_commands "$empty_doppler_output")"
assert_not_contains "$empty_doppler_log_output" "github-airtable-secret"

status=0
id_mismatch_output="$(
  EXPECTED_KEYS=GOOGLE_OAUTH_CLIENT_ID \
    GOOGLE_OAUTH_CLIENT_ID=doppler-google-client-id \
    REPOSITORY_VAR_GOOGLE_OAUTH_CLIENT_ID=github-google-client-id \
    run_verifier 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected client id mismatch case to fail"
fi
assert_contains "$id_mismatch_output" "GOOGLE_OAUTH_CLIENT_ID differs between GitHub variables and Doppler"
assert_contains "$id_mismatch_output" "1 OAuth client config comparison(s) failed"
id_mismatch_log_output="$(without_mask_commands "$id_mismatch_output")"
assert_not_contains "$id_mismatch_log_output" "doppler-google-client-id"
assert_not_contains "$id_mismatch_log_output" "github-google-client-id"

status=0
mixed_output="$(
  EXPECTED_KEYS=$'GOOGLE_OAUTH_CLIENT_SECRET\nSLACK_OAUTH_CLIENT_SECRET\nX_OAUTH_CLIENT_SECRET\nGH_OAUTH_CLIENT_SECRET' \
    GOOGLE_OAUTH_CLIENT_SECRET=shared-google-secret \
    REPOSITORY_SECRET_GOOGLE_OAUTH_CLIENT_SECRET=shared-google-secret \
    SLACK_OAUTH_CLIENT_SECRET=shared-slack-secret \
    REPOSITORY_SECRET_SLACK_OAUTH_CLIENT_SECRET=shared-slack-secret \
    GH_OAUTH_CLIENT_SECRET=doppler-github-secret \
    REPOSITORY_SECRET_GH_OAUTH_CLIENT_SECRET=github-github-secret \
    run_verifier 2>&1
)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected mixed verifier case to fail"
fi
assert_contains "$mixed_output" "ok: GOOGLE_OAUTH_CLIENT_SECRET"
assert_contains "$mixed_output" "ok: SLACK_OAUTH_CLIENT_SECRET"
assert_contains "$mixed_output" "X_OAUTH_CLIENT_SECRET is missing from Doppler (vm0/dev)"
assert_contains "$mixed_output" "GH_OAUTH_CLIENT_SECRET differs between GitHub secrets and Doppler"
assert_contains "$mixed_output" "2 OAuth client config comparison(s) failed"
mixed_log_output="$(without_mask_commands "$mixed_output")"
assert_not_contains "$mixed_log_output" "github-github-secret"
assert_not_contains "$mixed_log_output" "doppler-github-secret"

echo "verify-doppler-oauth-config-test: ok"
