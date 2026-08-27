#!/usr/bin/env bash
set -euo pipefail
set +x

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ACTION="${REPO_ROOT}/.github/actions/web-api-env/action.yml"
EXPECTED_BUILD_COMMIT_SHA="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)"
TEMP_DIRS=()
# These are not retired names. Their readers are live: lib/env.ts defines both,
# host.service.ts resolves the VM0-brand hosted-site host from them,
# artifact-preview.service.ts accepts the domain, and turbo.json still lists
# them. The action no longer sources either name and must not start again: an
# emitted value would restore the retired repo-variable source for live brand
# configuration, and for ZERO_HOST_SCHEME it would additionally feed the last
# remaining OKOU_ENV_FALLBACKS entry (OKOU_HOST_SCHEME) and falsify its drain
# evidence. Both retire with the VM0-brand host under #26701, and these
# assertions retire with them.
ZERO_KEYS_WITH_LIVE_READERS=(
  ZERO_HOST_DOMAIN
  ZERO_HOST_SCHEME
)
GITHUB_APP_VAR_SUFFIXES=(
  SLUG
  ID
  CLIENT_ID
)
GITHUB_APP_SECRET_SUFFIXES=(
  CLIENT_SECRET
  WEBHOOK_SECRET
  PRIVATE_KEY
)

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

assert_not_contains() {
  local output="$1"
  local unexpected="$2"
  if [[ "$output" == *"$unexpected"* ]]; then
    fail "did not expect output to contain: ${unexpected}"
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
    fail "unexpected value for ${key}"
  fi
}

assert_env_absent_value() {
  local env_file="$1"
  local unexpected="$2"
  if grep -Fq "$unexpected" "$env_file"; then
    fail "rendered env contained a forbidden fixture value"
  fi
}

assert_file_absent() {
  local path="$1"
  if [[ -e "$path" ]]; then
    fail "expected unpublished output file to be absent"
  fi
}

assert_env_key_absent() {
  local env_file="$1"
  local key="$2"
  if awk -F= -v key="$key" '$1 == key { found = 1 } END { exit !found }' "$env_file"; then
    fail "did not expect ${key} in ${env_file}"
  fi
}

assert_env_key_count() {
  local env_file="$1"
  local key="$2"
  local expected="$3"
  local count
  count="$(awk -F= -v key="$key" '$1 == key { count++ } END { print count + 0 }' "$env_file")"
  if [[ "$count" != "$expected" ]]; then
    fail "expected ${key} exactly ${expected} time(s) in ${env_file}"
  fi
}

assert_env_values_equal() {
  local env_file="$1"
  local first_key="$2"
  local second_key="$3"
  local first_value
  local second_value
  first_value="$(awk -F= -v key="$first_key" '$1 == key { sub(/^[^=]*=/, ""); print }' "$env_file")"
  second_value="$(awk -F= -v key="$second_key" '$1 == key { sub(/^[^=]*=/, ""); print }' "$env_file")"
  if [[ "$first_value" != "$second_value" ]]; then
    fail "expected ${first_key} and ${second_key} values to be equal"
  fi
}

assert_preview_job_ref_aliases_absent() {
  local env_file="$1"
  assert_env_key_absent "$env_file" OKOU_PREVIEW_JOB_REF
  assert_env_key_absent "$env_file" VM0_PREVIEW_JOB_REF
}

assert_debug_aliases_equal_dual() {
  local env_file="$1"
  assert_env_key_count "$env_file" OKOU_DEBUG 1
  assert_env_key_count "$env_file" VM0_DEBUG 1
  assert_env_value "$env_file" OKOU_DEBUG "*"
  assert_env_value "$env_file" VM0_DEBUG "*"
  assert_env_values_equal "$env_file" OKOU_DEBUG VM0_DEBUG
}

assert_debug_aliases_absent() {
  local env_file="$1"
  assert_env_key_absent "$env_file" OKOU_DEBUG
  assert_env_key_absent "$env_file" VM0_DEBUG
}

assert_api_backend_url_canonical_only() {
  local env_file="$1"
  local expected="$2"
  assert_env_key_count "$env_file" OKOU_API_BACKEND_URL 1
  assert_env_value "$env_file" OKOU_API_BACKEND_URL "$expected"
  assert_env_key_count "$env_file" VM0_API_BACKEND_URL 0
}

assert_machine_secret_canonical_only() {
  local env_file="$1"
  local expected="$2"
  assert_env_key_count "$env_file" OKOU_MACHINE_SECRET_KEY 1
  assert_env_value "$env_file" OKOU_MACHINE_SECRET_KEY "$expected"
  assert_env_key_count "$env_file" VM0_MACHINE_SECRET_KEY 0
}

assert_web_url_canonical_only() {
  local env_file="$1"
  local expected="$2"
  assert_env_key_count "$env_file" OKOU_WEB_URL 1
  assert_env_value "$env_file" OKOU_WEB_URL "$expected"
  assert_env_key_absent "$env_file" VM0_WEB_URL
}

assert_web_url_aliases_absent() {
  local env_file="$1"
  assert_env_key_absent "$env_file" OKOU_WEB_URL
  assert_env_key_absent "$env_file" VM0_WEB_URL
}

assert_zero_keys_with_live_readers_absent() {
  local env_file="$1"
  local key
  for key in "${ZERO_KEYS_WITH_LIVE_READERS[@]}"; do
    assert_env_key_absent "$env_file" "$key"
  done
}

assert_no_fixture_secret_values() {
  local output="$1"
  local unexpected
  for unexpected in \
    "github-" \
    "doppler-"; do
    if [[ "$output" == *"$unexpected"* ]]; then
      fail "render output exposed a fixture secret value"
    fi
  done
}

assert_github_app_source_state() {
  local output="$1"
  local suffix="$2"
  local state="$3"
  assert_contains \
    "$output" \
    "canonical_key=OKOU_GITHUB_APP_${suffix} legacy_key=VM0_GITHUB_APP_${suffix} state=${state}"
}

assert_github_app_source_states() {
  local output="$1"
  local state="$2"
  local suffix
  for suffix in "${GITHUB_APP_VAR_SUFFIXES[@]}" "${GITHUB_APP_SECRET_SUFFIXES[@]}"; do
    assert_github_app_source_state "$output" "$suffix" "$state"
  done
}

assert_github_app_source_evidence_absent() {
  local output="$1"
  local suffix
  for suffix in "${GITHUB_APP_VAR_SUFFIXES[@]}" "${GITHUB_APP_SECRET_SUFFIXES[@]}"; do
    assert_not_contains "$output" "canonical_key=OKOU_GITHUB_APP_${suffix}"
  done
}

assert_github_app_mapping_values() {
  local env_file="$1"
  local source_prefix="$2"
  local repo_vars_json="$3"
  local repo_secrets_json="$4"
  local suffix
  local expected
  for suffix in "${GITHUB_APP_VAR_SUFFIXES[@]}"; do
    expected="$(jq -r --arg key "${source_prefix}_GITHUB_APP_${suffix}" '.[$key] // ""' <<< "$repo_vars_json")"
    assert_env_value "$env_file" "GITHUB_APP_${suffix}" "$expected"
  done
  for suffix in "${GITHUB_APP_SECRET_SUFFIXES[@]}"; do
    expected="$(jq -r --arg key "${source_prefix}_GITHUB_APP_${suffix}" '.[$key] // ""' <<< "$repo_secrets_json")"
    assert_env_value "$env_file" "GITHUB_APP_${suffix}" "$expected"
  done
}

assert_github_app_empty_outputs() {
  local env_file="$1"
  local suffix
  for suffix in "${GITHUB_APP_VAR_SUFFIXES[@]}" "${GITHUB_APP_SECRET_SUFFIXES[@]}"; do
    assert_env_value "$env_file" "GITHUB_APP_${suffix}" ""
  done
}

assert_github_app_source_keys_absent() {
  local env_file="$1"
  local source_prefix
  local suffix
  for source_prefix in OKOU VM0; do
    for suffix in "${GITHUB_APP_VAR_SUFFIXES[@]}" "${GITHUB_APP_SECRET_SUFFIXES[@]}"; do
      assert_env_key_absent "$env_file" "${source_prefix}_GITHUB_APP_${suffix}"
    done
  done
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
  if [[ "$omit_key" != "STRIPE_OAUTH_CLIENT_ID" ]]; then
    json="$(jq -c --arg value "doppler-STRIPE_OAUTH_CLIENT_ID" '. + {STRIPE_OAUTH_CLIENT_ID: $value}' <<< "$json")"
  fi
  json="$(
    jq -c '
      . + {
        STRIPE_WEBHOOK_SECRET: "doppler-stripe-billing-webhook-secret",
        STRIPE_AUTOMATION_WEBHOOK_SECRET: "doppler-stripe-automation-webhook-secret"
      }
    ' <<< "$json"
  )"
  printf '%s' "$json"
}

run_action() {
  local doppler_secrets_json="$1"
  local test_dir="$2"
  local input_app="${3:-api}"
  local input_environment="${4:-preview}"
  local input_cli_pkg_url="${5-https://static.vm0.io/okou-cli/test-sha/package.tgz}"
  local branded_config="${6:-canonical}"
  local github_app_vars_json="${7:-}"
  local github_app_secrets_json="${8:-}"
  local input_job_ref="${9-pr-123}"
  local action_script="${test_dir}/web-api-env-action.sh"
  local github_output="${test_dir}/github-output"
  local repo_vars_json
  local repo_secrets_json

  if [[ -z "$github_app_vars_json" ]]; then
    github_app_vars_json="{}"
  fi
  if [[ -z "$github_app_secrets_json" ]]; then
    github_app_secrets_json="{}"
  fi

  repo_vars_json='{"GH_OAUTH_CLIENT_ID":"github-gh-client-id","SLACK_OAUTH_CLIENT_ID":"github-slack-client-id","VM0_API_BACKEND_URL":"https://api.github.test","GOOGLE_ADS_DEVELOPER_TOKEN":"github-google-ads-var","FINICITY_PARTNER_ID":"github-finicity-partner-id","POSTHOG_KEY":"github-posthog-key","POSTHOG_HOST":"https://posthog.github.test","ATOM_URL":"https://atom.github.test","STRIPE_OAUTH_CLIENT_ID":"ca_test_connect_client","STRIPE_CONCURRENCY_PORTAL_CONFIGURATION_ID":"bpc_test_concurrency","MICROSOFT_TEAMS_BOT_APP_ID":"github-teams-bot-app-id","MICROSOFT_TEAMS_APP_TENANT_ID":"github-teams-app-tenant-id","OKOU_PRICE_PRO":"price_test_pro","OKOU_PRICE_TEAM":"price_test_team","OKOU_PRICE_USAGE_PACK_PLAN_PRO":"price_test_usage_pack_plan_pro","OKOU_PRICE_USAGE_PACK_PLAN_TEAM":"price_test_usage_pack_plan_team","OKOU_PRICE_USAGE_PACK_20":"price_test_usage_pack_20","OKOU_PRICE_USAGE_PACK_50":"price_test_usage_pack_50","OKOU_PRICE_USAGE_PACK_100":"price_test_usage_pack_100","OKOU_PRICE_USAGE_PACK_200":"price_test_usage_pack_200","ATOM_GRANT_PRICE":"price_test_atom_grant","OKOU_PRICE_CUSTOM_CREDITS":"price_test_custom_credits","OKOU_PRICE_CUSTOM_CREDIT_UNIT":"price_test_custom_credit_unit","OKOU_PRICE_CONCURRENCY":"price_test_concurrency","GMAIL_PUBSUB_TOPIC_NAME":"projects/github/topics/gmail","GMAIL_PUBSUB_PUSH_AUDIENCE":"https://api.github.test/api/webhooks/gmail","GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL":"gmail-push@github.test","GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME":"projects/github/topics/google-workspace-events","GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE":"https://api.github.test/api/webhooks/google-workspace-events","GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL":"workspace-events-push@github.test"}'
  repo_vars_json="$(jq -c '. + {OKOU_PUBLIC_ARTIFACTS_BASE_URL: "https://cdn.okou.test", OKOU_PUBLIC_HOST_DOMAIN: "okou.app", OKOU_HOST_SCHEME: "https", OKOU_ONE_TIME_CAMPAIGN: "test-campaign"}' <<< "$repo_vars_json")"
  repo_secrets_json='{"GH_OAUTH_CLIENT_SECRET":"github-gh-client-secret","SLACK_OAUTH_CLIENT_SECRET":"github-slack-client-secret","GOOGLE_ADS_DEVELOPER_TOKEN":"github-google-ads-secret","OKOU_MAPS_GOOGLE_MAPS_TOKEN":"github-google-maps-token","OKOU_WEATHER_GOOGLE_WEATHER_TOKEN":"github-google-weather-token","OKOU_FINANCE_APIDOJO_TOKEN":"github-apidojo-token","OKOU_SEO_DATAFORSEO_LOGIN":"github-dataforseo-login","OKOU_SEO_DATAFORSEO_PASSWORD":"github-dataforseo-password","OKOU_BROWSER_USE_API_KEY":"github-browser-use-api-key","OKOU_SCRAPE_FIRECRAWL_TOKEN":"github-firecrawl-token","OKOU_WEB_SEARCH_PERPLEXITY_TOKEN":"github-perplexity-token","OKOU_SOCIAL_SOCIALKIT_TOKEN":"github-socialkit-token","STEAM_WEB_API_KEY":"github-steam-web-api-key","FINICITY_APP_KEY":"github-finicity-app-key","FINICITY_APP_SECRET":"github-finicity-app-secret","UNSPLASH_ACCESS_KEY":"github-unsplash-access-key","VM0_MACHINE_SECRET_KEY":"github-atom-machine-secret","MICROSOFT_TEAMS_BOT_APP_PASSWORD":"github-teams-bot-app-password","VERCEL_AUTOMATION_BYPASS_SECRET":"github-vercel-bypass-secret","CLOUDFLARE_BROWSER_RENDERING_API_TOKEN":"github-cloudflare-browser-rendering-token","ARTIFACT_PREVIEW_WAF_SECRET":"github-artifact-preview-waf-secret","JOGGAI_WEBHOOK_SECRET":"github-joggai-webhook-secret","STRIPE_WEBHOOK_SECRET":"github-stripe-billing-webhook-secret","STRIPE_AUTOMATION_WEBHOOK_SECRET":"github-stripe-automation-webhook-secret"}'
  if [[ "$branded_config" == "empty" ]]; then
    repo_vars_json="$(jq -c 'with_entries(select(.key | startswith("OKOU_") | not))' <<< "$repo_vars_json")"
    repo_secrets_json="$(jq -c 'with_entries(select(.key | startswith("OKOU_") | not))' <<< "$repo_secrets_json")"
  fi
  repo_vars_json="$(jq -c --argjson github_app_vars "$github_app_vars_json" '. + $github_app_vars' <<< "$repo_vars_json")"
  repo_secrets_json="$(jq -c --argjson github_app_secrets "$github_app_secrets_json" '. + $github_app_secrets' <<< "$repo_secrets_json")"

  extract_action_script > "$action_script"

  env \
    RUNNER_TEMP="$test_dir" \
    GITHUB_OUTPUT="$github_output" \
    GITHUB_SHA="test-sha" \
    INPUT_APP="$input_app" \
    INPUT_ENVIRONMENT="$input_environment" \
    INPUT_DATABASE_URL="postgres://preview-db" \
    INPUT_JOB_REF="$input_job_ref" \
    INPUT_WEB_URL="https://pr-123-www.vm0.test" \
    INPUT_APP_URL="https://pr-123-app.vm0.test" \
    INPUT_API_BACKEND_URL="https://pr-123-api-backend.vm0.test" \
    INPUT_CLI_PKG_URL="$input_cli_pkg_url" \
    REPO_VARS_JSON="$repo_vars_json" \
    REPO_SECRETS_JSON="$repo_secrets_json" \
    DOPPLER_SECRETS_JSON="$doppler_secrets_json" \
    bash "$action_script"
}

run_github_app_action() {
  local test_dir="$1"
  local repo_vars_json="$2"
  local repo_secrets_json="$3"
  run_action \
    "$(build_doppler_secrets_json)" \
    "$test_dir" \
    api \
    preview \
    "https://static.vm0.io/okou-cli/test-sha/package.tgz" \
    canonical \
    "$repo_vars_json" \
    "$repo_secrets_json"
}

if grep -En 'add_(var|secret) [A-Z0-9_]+_OAUTH_CLIENT_(ID|SECRET)' "$ACTION"; then
  fail "OAuth client id/secret entries must come from Doppler, not GitHub vars or secrets"
fi

if ! oauth_client_config_prefixes | grep -qx SLACK; then
  fail "expected Slack OAuth client config to come from Doppler"
fi

# Both the variable and the secret sources are canonical-only now, so no
# source read in the action may name a legacy ZERO_ variable or secret.
if grep -En '(repo_var|repo_secret|add_(var|secret) [A-Z0-9_]+) "?ZERO_' "$ACTION"; then
  fail "environment sources must read canonical OKOU_ names, not ZERO_"
fi

github_app_canonical_vars_json='{"OKOU_GITHUB_APP_SLUG":" github-canonical-slug ","OKOU_GITHUB_APP_ID":"github-canonical-id","OKOU_GITHUB_APP_CLIENT_ID":"github-canonical-client-id"}'
github_app_canonical_secrets_json='{"OKOU_GITHUB_APP_CLIENT_SECRET":"github-canonical-client-secret","OKOU_GITHUB_APP_WEBHOOK_SECRET":"github-canonical-webhook-secret","OKOU_GITHUB_APP_PRIVATE_KEY":"github-canonical-private-key"}'
github_app_canonical_dir="$(mktemp -d)"
TEMP_DIRS+=("$github_app_canonical_dir")
github_app_canonical_output="$(run_github_app_action "$github_app_canonical_dir" "$github_app_canonical_vars_json" "$github_app_canonical_secrets_json" 2>&1)"
github_app_canonical_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${github_app_canonical_dir}/github-output")"
assert_contains "$github_app_canonical_output" "Rendered"
assert_no_fixture_secret_values "$github_app_canonical_output"
assert_github_app_source_states "$github_app_canonical_output" "canonical-only"
assert_github_app_mapping_values "$github_app_canonical_env_file" OKOU "$github_app_canonical_vars_json" "$github_app_canonical_secrets_json"
assert_github_app_source_keys_absent "$github_app_canonical_env_file"

github_app_legacy_vars_json='{"VM0_GITHUB_APP_SLUG":" github-legacy-slug ","VM0_GITHUB_APP_ID":"github-legacy-id","VM0_GITHUB_APP_CLIENT_ID":"github-legacy-client-id"}'
github_app_legacy_secrets_json='{"VM0_GITHUB_APP_CLIENT_SECRET":"github-legacy-client-secret","VM0_GITHUB_APP_WEBHOOK_SECRET":"github-legacy-webhook-secret","VM0_GITHUB_APP_PRIVATE_KEY":"github-legacy-private-key"}'
github_app_legacy_dir="$(mktemp -d)"
TEMP_DIRS+=("$github_app_legacy_dir")
github_app_legacy_output="$(run_github_app_action "$github_app_legacy_dir" "$github_app_legacy_vars_json" "$github_app_legacy_secrets_json" 2>&1)"
github_app_legacy_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${github_app_legacy_dir}/github-output")"
assert_contains "$github_app_legacy_output" "Rendered"
assert_no_fixture_secret_values "$github_app_legacy_output"
assert_github_app_source_states "$github_app_legacy_output" "legacy-only"
assert_github_app_mapping_values "$github_app_legacy_env_file" VM0 "$github_app_legacy_vars_json" "$github_app_legacy_secrets_json"
assert_github_app_source_keys_absent "$github_app_legacy_env_file"

github_app_dual_vars_json='{"OKOU_GITHUB_APP_SLUG":" github-dual-slug ","VM0_GITHUB_APP_SLUG":" github-dual-slug ","OKOU_GITHUB_APP_ID":"github-dual-id","VM0_GITHUB_APP_ID":"github-dual-id","OKOU_GITHUB_APP_CLIENT_ID":"github-dual-client-id","VM0_GITHUB_APP_CLIENT_ID":"github-dual-client-id"}'
github_app_dual_secrets_json='{"OKOU_GITHUB_APP_CLIENT_SECRET":"github-dual-client-secret","VM0_GITHUB_APP_CLIENT_SECRET":"github-dual-client-secret","OKOU_GITHUB_APP_WEBHOOK_SECRET":"github-dual-webhook-secret","VM0_GITHUB_APP_WEBHOOK_SECRET":"github-dual-webhook-secret","OKOU_GITHUB_APP_PRIVATE_KEY":"github-dual-private-key","VM0_GITHUB_APP_PRIVATE_KEY":"github-dual-private-key"}'
github_app_dual_dir="$(mktemp -d)"
TEMP_DIRS+=("$github_app_dual_dir")
github_app_dual_output="$(run_github_app_action "$github_app_dual_dir" "$github_app_dual_vars_json" "$github_app_dual_secrets_json" 2>&1)"
github_app_dual_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${github_app_dual_dir}/github-output")"
assert_contains "$github_app_dual_output" "Rendered"
assert_no_fixture_secret_values "$github_app_dual_output"
assert_github_app_source_states "$github_app_dual_output" dual
assert_github_app_mapping_values "$github_app_dual_env_file" OKOU "$github_app_dual_vars_json" "$github_app_dual_secrets_json"
assert_github_app_source_keys_absent "$github_app_dual_env_file"

github_app_empty_dir="$(mktemp -d)"
TEMP_DIRS+=("$github_app_empty_dir")
github_app_empty_output="$(run_github_app_action "$github_app_empty_dir" '{}' '{}' 2>&1)"
github_app_empty_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${github_app_empty_dir}/github-output")"
assert_contains "$github_app_empty_output" "Rendered"
assert_no_fixture_secret_values "$github_app_empty_output"
assert_github_app_source_evidence_absent "$github_app_empty_output"
assert_github_app_empty_outputs "$github_app_empty_env_file"
assert_github_app_source_keys_absent "$github_app_empty_env_file"

github_app_var_conflict_dir="$(mktemp -d)"
TEMP_DIRS+=("$github_app_var_conflict_dir")
status=0
github_app_var_conflict_output="$(run_github_app_action "$github_app_var_conflict_dir" '{"OKOU_GITHUB_APP_SLUG":"github-canonical-conflict","VM0_GITHUB_APP_SLUG":"github-legacy-conflict"}' '{}' 2>&1)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected conflicting GitHub App variable aliases to fail"
fi
assert_contains "$github_app_var_conflict_output" "canonical_key=OKOU_GITHUB_APP_SLUG legacy_key=VM0_GITHUB_APP_SLUG state=conflict"
assert_no_fixture_secret_values "$github_app_var_conflict_output"
assert_file_absent "${github_app_var_conflict_dir}/github-output"
assert_file_absent "${github_app_var_conflict_dir}/web-api-api-preview.env"

github_app_secret_conflict_dir="$(mktemp -d)"
TEMP_DIRS+=("$github_app_secret_conflict_dir")
status=0
github_app_secret_conflict_output="$(run_github_app_action "$github_app_secret_conflict_dir" '{}' '{"OKOU_GITHUB_APP_CLIENT_SECRET":"github-canonical-conflict-secret","VM0_GITHUB_APP_CLIENT_SECRET":"github-legacy-conflict-secret"}' 2>&1)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected conflicting GitHub App secret aliases to fail"
fi
assert_contains "$github_app_secret_conflict_output" "canonical_key=OKOU_GITHUB_APP_CLIENT_SECRET legacy_key=VM0_GITHUB_APP_CLIENT_SECRET state=conflict"
assert_no_fixture_secret_values "$github_app_secret_conflict_output"
assert_file_absent "${github_app_secret_conflict_dir}/github-output"
assert_file_absent "${github_app_secret_conflict_dir}/web-api-api-preview.env"

success_dir="$(mktemp -d)"
TEMP_DIRS+=("$success_dir")
success_output="$(run_action "$(build_doppler_secrets_json)" "$success_dir" 2>&1)"
success_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${success_dir}/github-output")"
assert_contains "$success_output" "Rendered"
assert_no_fixture_secret_values "$success_output"
assert_zero_keys_with_live_readers_absent "$success_env_file"
assert_debug_aliases_equal_dual "$success_env_file"
assert_env_value "$success_env_file" GH_OAUTH_CLIENT_ID "doppler-GH_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" GH_OAUTH_CLIENT_SECRET "doppler-GH_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" SLACK_OAUTH_CLIENT_ID "doppler-SLACK_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" SLACK_OAUTH_CLIENT_SECRET "doppler-SLACK_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" BOX_OAUTH_CLIENT_ID "doppler-BOX_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" BOX_OAUTH_CLIENT_SECRET "doppler-BOX_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" QUICKBOOKS_OAUTH_CLIENT_ID "doppler-QUICKBOOKS_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" QUICKBOOKS_OAUTH_CLIENT_SECRET "doppler-QUICKBOOKS_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" TIKTOK_ADS_OAUTH_CLIENT_ID "doppler-TIKTOK_ADS_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" TIKTOK_ADS_OAUTH_CLIENT_SECRET "doppler-TIKTOK_ADS_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" MICROSOFT_TEAMS_BOT_APP_ID "github-teams-bot-app-id"
assert_env_value "$success_env_file" MICROSOFT_TEAMS_BOT_APP_PASSWORD "github-teams-bot-app-password"
assert_env_value "$success_env_file" MICROSOFT_TEAMS_APP_TENANT_ID "github-teams-app-tenant-id"
assert_env_value "$success_env_file" GOOGLE_ADS_DEVELOPER_TOKEN "github-google-ads-secret"
assert_env_value "$success_env_file" OKOU_MAPS_GOOGLE_MAPS_TOKEN "github-google-maps-token"
assert_env_value "$success_env_file" OKOU_WEATHER_GOOGLE_WEATHER_TOKEN "github-google-weather-token"
assert_env_value "$success_env_file" OKOU_FINANCE_APIDOJO_TOKEN "github-apidojo-token"
assert_env_value "$success_env_file" OKOU_SEO_DATAFORSEO_LOGIN "github-dataforseo-login"
assert_env_value "$success_env_file" OKOU_SEO_DATAFORSEO_PASSWORD "github-dataforseo-password"
assert_env_value "$success_env_file" OKOU_BROWSER_USE_API_KEY "github-browser-use-api-key"
assert_env_value "$success_env_file" OKOU_SCRAPE_FIRECRAWL_TOKEN "github-firecrawl-token"
assert_env_value "$success_env_file" OKOU_WEB_SEARCH_PERPLEXITY_TOKEN "github-perplexity-token"
assert_env_value "$success_env_file" OKOU_SOCIAL_SOCIALKIT_TOKEN "github-socialkit-token"
assert_env_value "$success_env_file" STEAM_WEB_API_KEY "github-steam-web-api-key"
assert_env_value "$success_env_file" FINICITY_APP_KEY "github-finicity-app-key"
assert_env_value "$success_env_file" FINICITY_APP_SECRET "github-finicity-app-secret"
assert_env_value "$success_env_file" FINICITY_PARTNER_ID "github-finicity-partner-id"
assert_env_value "$success_env_file" UNSPLASH_ACCESS_KEY "github-unsplash-access-key"
assert_env_value "$success_env_file" ATOM_URL "https://tunnel-yuma-atom-api.vm7.ai"
assert_machine_secret_canonical_only "$success_env_file" "github-atom-machine-secret"
assert_env_value "$success_env_file" VERCEL_AUTOMATION_BYPASS_SECRET "github-vercel-bypass-secret"
assert_env_key_count "$success_env_file" OKOU_PREVIEW_JOB_REF 1
assert_env_key_count "$success_env_file" VM0_PREVIEW_JOB_REF 1
assert_env_value "$success_env_file" OKOU_PREVIEW_JOB_REF "pr-123"
assert_env_value "$success_env_file" VM0_PREVIEW_JOB_REF "pr-123"
assert_env_values_equal "$success_env_file" OKOU_PREVIEW_JOB_REF VM0_PREVIEW_JOB_REF
assert_api_backend_url_canonical_only "$success_env_file" "https://pr-123-api-backend.vm0.test"
assert_env_value "$success_env_file" FEISHU_CALLBACK_BASE_URL "https://pr-123-api-backend.vm0.test"
assert_env_value "$success_env_file" FINICITY_WEBHOOK_BASE_URL "https://pr-123-api-backend.vm0.test"
assert_web_url_canonical_only "$success_env_file" "https://pr-123-www.vm0.test"
assert_env_value "$success_env_file" CLI_PKG_URL "https://static.vm0.io/okou-cli/test-sha/package.tgz"
assert_env_value "$success_env_file" GIT_COMMIT_SHA "$EXPECTED_BUILD_COMMIT_SHA"
assert_env_absent_value "$success_env_file" "ONBOARDING_URL="
assert_env_value "$success_env_file" OKOU_PRICE_PRO "price_test_pro"
assert_env_value "$success_env_file" OKOU_PRICE_TEAM "price_test_team"
assert_env_value "$success_env_file" OKOU_PRICE_USAGE_PACK_PLAN_PRO "price_test_usage_pack_plan_pro"
assert_env_value "$success_env_file" OKOU_PRICE_USAGE_PACK_PLAN_TEAM "price_test_usage_pack_plan_team"
assert_env_value "$success_env_file" OKOU_PRICE_USAGE_PACK_20 "price_test_usage_pack_20"
assert_env_value "$success_env_file" OKOU_PRICE_USAGE_PACK_50 "price_test_usage_pack_50"
assert_env_value "$success_env_file" OKOU_PRICE_USAGE_PACK_100 "price_test_usage_pack_100"
assert_env_value "$success_env_file" OKOU_PRICE_USAGE_PACK_200 "price_test_usage_pack_200"
assert_env_value "$success_env_file" ATOM_GRANT_PRICE "price_test_atom_grant"
assert_env_value "$success_env_file" OKOU_PRICE_CUSTOM_CREDITS "price_test_custom_credits"
assert_env_value "$success_env_file" OKOU_PRICE_CUSTOM_CREDIT_UNIT "price_test_custom_credit_unit"
assert_env_value "$success_env_file" OKOU_PRICE_CONCURRENCY "price_test_concurrency"
assert_env_value "$success_env_file" OKOU_PUBLIC_ARTIFACTS_BASE_URL "https://cdn.okou.test"
assert_env_value "$success_env_file" OKOU_PUBLIC_HOST_DOMAIN "okou.app"
assert_env_value "$success_env_file" OKOU_HOST_SCHEME "https"
assert_env_value "$success_env_file" OKOU_ONE_TIME_CAMPAIGN "test-campaign"
assert_env_value "$success_env_file" GMAIL_PUBSUB_TOPIC_NAME "projects/github/topics/gmail"
assert_env_value "$success_env_file" GMAIL_PUBSUB_PUSH_AUDIENCE "https://api.github.test/api/webhooks/gmail"
assert_env_value "$success_env_file" GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL "gmail-push@github.test"
assert_env_value "$success_env_file" GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME "projects/github/topics/google-workspace-events"
assert_env_value "$success_env_file" GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE "https://api.github.test/api/webhooks/google-workspace-events"
assert_env_value "$success_env_file" GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL "workspace-events-push@github.test"
assert_env_value "$success_env_file" STRIPE_OAUTH_CLIENT_ID "doppler-STRIPE_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" STRIPE_CONCURRENCY_PORTAL_CONFIGURATION_ID "bpc_test_concurrency"
assert_env_absent_value "$success_env_file" "github-gh-client-id"
assert_env_absent_value "$success_env_file" "github-gh-client-secret"
assert_env_absent_value "$success_env_file" "github-slack-client-id"
assert_env_absent_value "$success_env_file" "github-slack-client-secret"
assert_env_absent_value "$success_env_file" "github-posthog-key"
assert_env_absent_value "$success_env_file" "github-cloudflare-browser-rendering-token"
assert_env_absent_value "$success_env_file" "github-artifact-preview-waf-secret"

preview_web_dir="$(mktemp -d)"
TEMP_DIRS+=("$preview_web_dir")
preview_web_output="$(run_action "$(build_doppler_secrets_json)" "$preview_web_dir" web preview 2>&1)"
preview_web_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${preview_web_dir}/github-output")"
assert_contains "$preview_web_output" "Rendered"
assert_preview_job_ref_aliases_absent "$preview_web_env_file"
assert_debug_aliases_equal_dual "$preview_web_env_file"
assert_api_backend_url_canonical_only "$preview_web_env_file" "https://pr-123-api-backend.vm0.test"
assert_env_key_absent "$preview_web_env_file" OKOU_MACHINE_SECRET_KEY
assert_env_key_absent "$preview_web_env_file" VM0_MACHINE_SECRET_KEY
assert_web_url_aliases_absent "$preview_web_env_file"

empty_job_ref_dir="$(mktemp -d)"
TEMP_DIRS+=("$empty_job_ref_dir")
empty_job_ref_output="$(run_action "$(build_doppler_secrets_json)" "$empty_job_ref_dir" api preview "https://static.vm0.io/okou-cli/test-sha/package.tgz" canonical "" "" "" 2>&1)"
empty_job_ref_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${empty_job_ref_dir}/github-output")"
assert_contains "$empty_job_ref_output" "Rendered"
assert_preview_job_ref_aliases_absent "$empty_job_ref_env_file"
assert_debug_aliases_equal_dual "$empty_job_ref_env_file"
assert_api_backend_url_canonical_only "$empty_job_ref_env_file" "https://pr-123-api-backend.vm0.test"
assert_machine_secret_canonical_only "$empty_job_ref_env_file" "github-atom-machine-secret"

empty_dir="$(mktemp -d)"
TEMP_DIRS+=("$empty_dir")
empty_output="$(run_action "$(build_doppler_secrets_json)" "$empty_dir" api preview "https://static.vm0.io/okou-cli/test-sha/package.tgz" empty 2>&1)"
empty_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${empty_dir}/github-output")"
assert_contains "$empty_output" "Rendered"
assert_no_fixture_secret_values "$empty_output"
assert_zero_keys_with_live_readers_absent "$empty_env_file"
assert_debug_aliases_equal_dual "$empty_env_file"
assert_api_backend_url_canonical_only "$empty_env_file" "https://pr-123-api-backend.vm0.test"
assert_machine_secret_canonical_only "$empty_env_file" "github-atom-machine-secret"
assert_env_value "$empty_env_file" OKOU_PUBLIC_ARTIFACTS_BASE_URL ""
assert_env_value "$empty_env_file" OKOU_PUBLIC_HOST_DOMAIN ""
assert_env_value "$empty_env_file" OKOU_MAPS_GOOGLE_MAPS_TOKEN ""
assert_env_value "$empty_env_file" OKOU_SOCIAL_SOCIALKIT_TOKEN ""
assert_env_value "$empty_env_file" OKOU_SEO_DATAFORSEO_LOGIN ""
assert_env_value "$empty_env_file" OKOU_PRICE_PRO ""
assert_env_value "$empty_env_file" OKOU_ONE_TIME_CAMPAIGN ""

production_web_dir="$(mktemp -d)"
TEMP_DIRS+=("$production_web_dir")
production_web_output="$(run_action "$(build_doppler_secrets_json)" "$production_web_dir" web production 2>&1)"
production_web_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${production_web_dir}/github-output")"
assert_contains "$production_web_output" "Rendered"
assert_no_fixture_secret_values "$production_web_output"
assert_zero_keys_with_live_readers_absent "$production_web_env_file"
assert_debug_aliases_absent "$production_web_env_file"
assert_api_backend_url_canonical_only "$production_web_env_file" "https://pr-123-api-backend.vm0.test"
assert_web_url_aliases_absent "$production_web_env_file"
assert_env_value "$production_web_env_file" POSTHOG_KEY "github-posthog-key"
assert_env_value "$production_web_env_file" POSTHOG_HOST "https://posthog.github.test"
assert_env_value "$production_web_env_file" GIT_COMMIT_SHA "$EXPECTED_BUILD_COMMIT_SHA"
assert_env_absent_value "$production_web_env_file" "ATOM_URL="
assert_env_key_absent "$production_web_env_file" OKOU_MACHINE_SECRET_KEY
assert_env_key_absent "$production_web_env_file" VM0_MACHINE_SECRET_KEY
assert_env_absent_value "$production_web_env_file" "CLI_PKG_URL="
assert_env_absent_value "$production_web_env_file" "JOGGAI_WEBHOOK_SECRET="
assert_env_value "$production_web_env_file" OKOU_WEATHER_GOOGLE_WEATHER_TOKEN "github-google-weather-token"
assert_env_value "$production_web_env_file" OKOU_FINANCE_APIDOJO_TOKEN "github-apidojo-token"
assert_env_absent_value "$production_web_env_file" "OKOU_SEO_DATAFORSEO_LOGIN="
assert_env_absent_value "$production_web_env_file" "OKOU_SEO_DATAFORSEO_PASSWORD="
assert_env_value "$production_web_env_file" OKOU_SCRAPE_FIRECRAWL_TOKEN "github-firecrawl-token"
assert_env_value "$production_web_env_file" OKOU_WEB_SEARCH_PERPLEXITY_TOKEN "github-perplexity-token"
assert_env_absent_value "$production_web_env_file" "OKOU_SOCIAL_SOCIALKIT_TOKEN="
assert_env_absent_value "$production_web_env_file" "OKOU_BROWSER_USE_API_KEY="
assert_env_absent_value "$production_web_env_file" "github-cloudflare-browser-rendering-token"
assert_env_absent_value "$production_web_env_file" "github-artifact-preview-waf-secret"

production_api_dir="$(mktemp -d)"
TEMP_DIRS+=("$production_api_dir")
production_api_output="$(run_action "$(build_doppler_secrets_json)" "$production_api_dir" api production 2>&1)"
production_api_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${production_api_dir}/github-output")"
assert_contains "$production_api_output" "Rendered"
assert_no_fixture_secret_values "$production_api_output"
assert_zero_keys_with_live_readers_absent "$production_api_env_file"
assert_debug_aliases_absent "$production_api_env_file"
assert_web_url_canonical_only "$production_api_env_file" "https://pr-123-www.vm0.test"
assert_api_backend_url_canonical_only "$production_api_env_file" "https://pr-123-api-backend.vm0.test"
assert_env_value "$production_api_env_file" FEISHU_CALLBACK_BASE_URL "https://pr-123-api-backend.vm0.test"
assert_env_value "$production_api_env_file" FINICITY_WEBHOOK_BASE_URL "https://pr-123-api-backend.vm0.test"
assert_env_value "$production_api_env_file" CLI_PKG_URL "https://static.vm0.io/okou-cli/test-sha/package.tgz"
assert_env_value "$production_api_env_file" ATOM_URL "https://atom.github.test"
assert_machine_secret_canonical_only "$production_api_env_file" "github-atom-machine-secret"
assert_env_value "$production_api_env_file" JOGGAI_WEBHOOK_SECRET "github-joggai-webhook-secret"
assert_env_value "$production_api_env_file" MICROSOFT_TEAMS_BOT_APP_ID "github-teams-bot-app-id"
assert_env_value "$production_api_env_file" MICROSOFT_TEAMS_BOT_APP_PASSWORD "github-teams-bot-app-password"
assert_env_value "$production_api_env_file" MICROSOFT_TEAMS_APP_TENANT_ID "github-teams-app-tenant-id"
assert_env_value "$production_api_env_file" OKOU_WEATHER_GOOGLE_WEATHER_TOKEN "github-google-weather-token"
assert_env_value "$production_api_env_file" OKOU_FINANCE_APIDOJO_TOKEN "github-apidojo-token"
assert_env_value "$production_api_env_file" OKOU_SEO_DATAFORSEO_LOGIN "github-dataforseo-login"
assert_env_value "$production_api_env_file" OKOU_SEO_DATAFORSEO_PASSWORD "github-dataforseo-password"
assert_env_value "$production_api_env_file" OKOU_BROWSER_USE_API_KEY "github-browser-use-api-key"
assert_env_value "$production_api_env_file" OKOU_SCRAPE_FIRECRAWL_TOKEN "github-firecrawl-token"
assert_env_value "$production_api_env_file" OKOU_WEB_SEARCH_PERPLEXITY_TOKEN "github-perplexity-token"
assert_env_value "$production_api_env_file" OKOU_SOCIAL_SOCIALKIT_TOKEN "github-socialkit-token"
assert_env_absent_value "$production_api_env_file" "ONBOARDING_URL="
assert_env_value "$production_api_env_file" CLOUDFLARE_BROWSER_RENDERING_API_TOKEN "github-cloudflare-browser-rendering-token"
assert_env_value "$production_api_env_file" ARTIFACT_PREVIEW_WAF_SECRET "github-artifact-preview-waf-secret"
assert_env_value "$production_api_env_file" STRIPE_WEBHOOK_SECRET "github-stripe-billing-webhook-secret"
assert_env_value "$production_api_env_file" STRIPE_AUTOMATION_WEBHOOK_SECRET "github-stripe-automation-webhook-secret"
assert_env_absent_value "$production_api_env_file" "doppler-stripe-billing-webhook-secret"
assert_env_absent_value "$production_api_env_file" "doppler-stripe-automation-webhook-secret"
assert_preview_job_ref_aliases_absent "$production_api_env_file"

missing_dir="$(mktemp -d)"
TEMP_DIRS+=("$missing_dir")
status=0
missing_output="$(run_action "$(build_doppler_secrets_json GH_OAUTH_CLIENT_SECRET)" "$missing_dir" 2>&1)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing Doppler OAuth client config to fail"
fi
assert_contains "$missing_output" "::error::GH_OAUTH_CLIENT_SECRET is missing from Doppler OAuth config"

missing_stripe_dir="$(mktemp -d)"
TEMP_DIRS+=("$missing_stripe_dir")
status=0
missing_stripe_output="$(run_action "$(build_doppler_secrets_json STRIPE_OAUTH_CLIENT_ID)" "$missing_stripe_dir" 2>&1)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing Stripe Doppler OAuth client id to fail"
fi
assert_contains "$missing_stripe_output" "::error::STRIPE_OAUTH_CLIENT_ID is missing from Doppler OAuth config"

missing_cli_pkg_dir="$(mktemp -d)"
TEMP_DIRS+=("$missing_cli_pkg_dir")
status=0
missing_cli_pkg_output="$(run_action "$(build_doppler_secrets_json)" "$missing_cli_pkg_dir" api preview "" 2>&1)" || status=$?
if [[ "$status" -eq 0 ]]; then
  fail "expected missing API CLI package URL to fail"
fi
assert_contains "$missing_cli_pkg_output" "::error::cli-pkg-url is required for API deployments"

echo "web-api-env-action-test: ok"
