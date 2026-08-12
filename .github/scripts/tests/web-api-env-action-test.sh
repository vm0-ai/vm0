#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ACTION="${REPO_ROOT}/.github/actions/web-api-env/action.yml"
EXPECTED_BUILD_COMMIT_SHA="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)"
TEMP_DIRS=()
MIGRATED_ZERO_OUTPUT_KEYS=(
  ZERO_HOST_DOMAIN
  ZERO_HOST_SCHEME
  ZERO_MAPS_GOOGLE_MAPS_TOKEN
  ZERO_WEATHER_GOOGLE_WEATHER_TOKEN
  ZERO_SCRAPE_FIRECRAWL_TOKEN
  ZERO_WEB_SEARCH_PERPLEXITY_TOKEN
  ZERO_FINANCE_APIDOJO_TOKEN
  ZERO_SEO_DATAFORSEO_LOGIN
  ZERO_SEO_DATAFORSEO_PASSWORD
  ZERO_BROWSER_USE_API_KEY
  ZERO_PRICE_PRO
  ZERO_PRICE_TEAM
  ZERO_PRICE_USAGE_PACK_PLAN_PRO
  ZERO_PRICE_USAGE_PACK_PLAN_TEAM
  ZERO_PRICE_USAGE_PACK_20
  ZERO_PRICE_USAGE_PACK_50
  ZERO_PRICE_USAGE_PACK_100
  ZERO_PRICE_USAGE_PACK_200
  ZERO_PRICE_CUSTOM_CREDITS
  ZERO_PRICE_CUSTOM_CREDIT_UNIT
  ZERO_PRICE_CONCURRENCY
  ZERO_ONE_TIME_CAMPAIGN
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

assert_env_key_absent() {
  local env_file="$1"
  local key="$2"
  if awk -F= -v key="$key" '$1 == key { found = 1 } END { exit !found }' "$env_file"; then
    fail "did not expect ${key} in ${env_file}"
  fi
}

assert_migrated_zero_outputs_absent() {
  local env_file="$1"
  local key
  for key in "${MIGRATED_ZERO_OUTPUT_KEYS[@]}"; do
    assert_env_key_absent "$env_file" "$key"
  done
}

assert_migrated_okou_outputs_match() {
  local expected_env_file="$1"
  local actual_env_file="$2"
  local zero_key okou_key expected actual
  for zero_key in "${MIGRATED_ZERO_OUTPUT_KEYS[@]}"; do
    okou_key="${zero_key/ZERO_/OKOU_}"
    if ! expected="$(awk -F= -v key="$okou_key" '$1 == key { sub(/^[^=]*=/, ""); print; found = 1 } END { if (!found) exit 1 }' "$expected_env_file")"; then
      assert_env_key_absent "$actual_env_file" "$okou_key"
      continue
    fi
    actual="$(awk -F= -v key="$okou_key" '$1 == key { sub(/^[^=]*=/, ""); print; found = 1 } END { if (!found) exit 1 }' "$actual_env_file")" ||
      fail "expected ${okou_key} in ${actual_env_file}"
    if [[ -z "$actual" ]]; then
      fail "expected non-empty canonical source for ${okou_key}"
    fi
    if [[ "$actual" != "$expected" ]]; then
      fail "expected canonical source for ${okou_key} to match legacy fallback"
    fi
  done
}

assert_no_fixture_secret_values() {
  local output="$1"
  local unexpected
  for unexpected in \
    "github-" \
    "doppler-" \
    "okou-google-weather-token" \
    "okou-dataforseo-login" \
    "okou-browser-use-api-key"; do
    if [[ "$output" == *"$unexpected"* ]]; then
      fail "render output exposed a fixture secret value"
    fi
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
  local branded_config="${6:-legacy}"
  local action_script="${test_dir}/web-api-env-action.sh"
  local github_output="${test_dir}/github-output"
  local repo_vars_json
  local repo_secrets_json

  repo_vars_json='{"GH_OAUTH_CLIENT_ID":"github-gh-client-id","SLACK_OAUTH_CLIENT_ID":"github-slack-client-id","VM0_API_BACKEND_URL":"https://api.github.test","GOOGLE_ADS_DEVELOPER_TOKEN":"github-google-ads-var","FINICITY_PARTNER_ID":"github-finicity-partner-id","POSTHOG_KEY":"github-posthog-key","POSTHOG_HOST":"https://posthog.github.test","ATOM_URL":"https://atom.github.test","STRIPE_OAUTH_CLIENT_ID":"ca_test_connect_client","STRIPE_CONCURRENCY_PORTAL_CONFIGURATION_ID":"bpc_test_concurrency","MICROSOFT_TEAMS_BOT_APP_ID":"github-teams-bot-app-id","MICROSOFT_TEAMS_APP_TENANT_ID":"github-teams-app-tenant-id","ZERO_PRICE_PRO":"price_test_pro","ZERO_PRICE_TEAM":"price_test_team","ZERO_PRICE_USAGE_PACK_PLAN_PRO":"price_test_usage_pack_plan_pro","ZERO_PRICE_USAGE_PACK_PLAN_TEAM":"price_test_usage_pack_plan_team","ZERO_PRICE_USAGE_PACK_20":"price_test_usage_pack_20","ZERO_PRICE_USAGE_PACK_50":"price_test_usage_pack_50","ZERO_PRICE_USAGE_PACK_100":"price_test_usage_pack_100","ZERO_PRICE_USAGE_PACK_200":"price_test_usage_pack_200","ATOM_GRANT_PRICE":"price_test_atom_grant","ZERO_PRICE_CUSTOM_CREDITS":"price_test_custom_credits","ZERO_PRICE_CUSTOM_CREDIT_UNIT":"price_test_custom_credit_unit","ZERO_PRICE_CONCURRENCY":"price_test_concurrency","GMAIL_PUBSUB_TOPIC_NAME":"projects/github/topics/gmail","GMAIL_PUBSUB_PUSH_AUDIENCE":"https://api.github.test/api/webhooks/gmail","GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL":"gmail-push@github.test","GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME":"projects/github/topics/google-workspace-events","GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE":"https://api.github.test/api/webhooks/google-workspace-events","GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL":"workspace-events-push@github.test"}'
  repo_vars_json="$(jq -c '. + {ZERO_HOST_DOMAIN: "zero-sites.test", ZERO_HOST_SCHEME: "https", ZERO_ONE_TIME_CAMPAIGN: "zero-campaign"}' <<< "$repo_vars_json")"
  repo_secrets_json='{"GH_OAUTH_CLIENT_SECRET":"github-gh-client-secret","SLACK_OAUTH_CLIENT_SECRET":"github-slack-client-secret","GOOGLE_ADS_DEVELOPER_TOKEN":"github-google-ads-secret","ZERO_MAPS_GOOGLE_MAPS_TOKEN":"github-google-maps-token","ZERO_WEATHER_GOOGLE_WEATHER_TOKEN":"github-google-weather-token","ZERO_FINANCE_APIDOJO_TOKEN":"github-apidojo-token","ZERO_SEO_DATAFORSEO_LOGIN":"github-dataforseo-login","ZERO_SEO_DATAFORSEO_PASSWORD":"github-dataforseo-password","ZERO_BROWSER_USE_API_KEY":"github-browser-use-api-key","ZERO_SCRAPE_FIRECRAWL_TOKEN":"github-firecrawl-token","ZERO_WEB_SEARCH_PERPLEXITY_TOKEN":"github-perplexity-token","STEAM_WEB_API_KEY":"github-steam-web-api-key","FINICITY_APP_KEY":"github-finicity-app-key","FINICITY_APP_SECRET":"github-finicity-app-secret","UNSPLASH_ACCESS_KEY":"github-unsplash-access-key","VM0_MACHINE_SECRET_KEY":"github-atom-machine-secret","MICROSOFT_TEAMS_BOT_APP_PASSWORD":"github-teams-bot-app-password","VERCEL_AUTOMATION_BYPASS_SECRET":"github-vercel-bypass-secret","CLOUDFLARE_BROWSER_RENDERING_API_TOKEN":"github-cloudflare-browser-rendering-token","ARTIFACT_PREVIEW_WAF_SECRET":"github-artifact-preview-waf-secret","JOGGAI_WEBHOOK_SECRET":"github-joggai-webhook-secret","STRIPE_WEBHOOK_SECRET":"github-stripe-billing-webhook-secret","STRIPE_AUTOMATION_WEBHOOK_SECRET":"github-stripe-automation-webhook-secret"}'
  if [[ "$branded_config" == "both" ]]; then
    repo_vars_json="$(jq -c '. + {OKOU_HOST_DOMAIN: "okou-sites.test", OKOU_HOST_SCHEME: "http", OKOU_PRICE_PRO: "price_okou_pro", OKOU_ONE_TIME_CAMPAIGN: "okou-campaign"}' <<< "$repo_vars_json")"
    repo_secrets_json="$(jq -c '. + {OKOU_WEATHER_GOOGLE_WEATHER_TOKEN: "okou-google-weather-token", OKOU_SEO_DATAFORSEO_LOGIN: "okou-dataforseo-login", OKOU_BROWSER_USE_API_KEY: "okou-browser-use-api-key"}' <<< "$repo_secrets_json")"
  elif [[ "$branded_config" == "canonical" ]]; then
    repo_vars_json="$(jq -c 'with_entries(if (.key | startswith("ZERO_")) then .key |= sub("^ZERO_"; "OKOU_") else . end)' <<< "$repo_vars_json")"
    repo_secrets_json="$(jq -c 'with_entries(if (.key | startswith("ZERO_")) then .key |= sub("^ZERO_"; "OKOU_") else . end)' <<< "$repo_secrets_json")"
  elif [[ "$branded_config" == "empty" ]]; then
    repo_vars_json="$(jq -c 'with_entries(select(.key | startswith("ZERO_") | not))' <<< "$repo_vars_json")"
    repo_secrets_json="$(jq -c 'with_entries(select(.key | startswith("ZERO_") | not))' <<< "$repo_secrets_json")"
  fi

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
    INPUT_API_BACKEND_URL="https://pr-123-api-backend.vm0.test" \
    INPUT_CLI_PKG_URL="$input_cli_pkg_url" \
    REPO_VARS_JSON="$repo_vars_json" \
    REPO_SECRETS_JSON="$repo_secrets_json" \
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
success_output="$(run_action "$(build_doppler_secrets_json)" "$success_dir" 2>&1)"
success_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${success_dir}/github-output")"
assert_contains "$success_output" "Rendered"
assert_no_fixture_secret_values "$success_output"
assert_migrated_zero_outputs_absent "$success_env_file"
assert_env_value "$success_env_file" GH_OAUTH_CLIENT_ID "doppler-GH_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" GH_OAUTH_CLIENT_SECRET "doppler-GH_OAUTH_CLIENT_SECRET"
assert_env_value "$success_env_file" SLACK_OAUTH_CLIENT_ID "doppler-SLACK_OAUTH_CLIENT_ID"
assert_env_value "$success_env_file" SLACK_OAUTH_CLIENT_SECRET "doppler-SLACK_OAUTH_CLIENT_SECRET"
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
assert_env_value "$success_env_file" STEAM_WEB_API_KEY "github-steam-web-api-key"
assert_env_value "$success_env_file" FINICITY_APP_KEY "github-finicity-app-key"
assert_env_value "$success_env_file" FINICITY_APP_SECRET "github-finicity-app-secret"
assert_env_value "$success_env_file" FINICITY_PARTNER_ID "github-finicity-partner-id"
assert_env_value "$success_env_file" UNSPLASH_ACCESS_KEY "github-unsplash-access-key"
assert_env_value "$success_env_file" ATOM_URL "https://tunnel-yuma-atom-api.vm7.ai"
assert_env_value "$success_env_file" VM0_MACHINE_SECRET_KEY "github-atom-machine-secret"
assert_env_value "$success_env_file" VERCEL_AUTOMATION_BYPASS_SECRET "github-vercel-bypass-secret"
assert_env_value "$success_env_file" VM0_PREVIEW_JOB_REF "pr-123"
assert_env_value "$success_env_file" VM0_API_BACKEND_URL "https://pr-123-api-backend.vm0.test"
assert_env_value "$success_env_file" FEISHU_CALLBACK_BASE_URL "https://pr-123-api-backend.vm0.test"
assert_env_value "$success_env_file" VM0_WEB_URL "https://pr-123-www.vm0.test"
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
assert_env_value "$success_env_file" OKOU_HOST_DOMAIN "zero-sites.test"
assert_env_value "$success_env_file" OKOU_HOST_SCHEME "https"
assert_env_value "$success_env_file" OKOU_ONE_TIME_CAMPAIGN "zero-campaign"
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

canonical_dir="$(mktemp -d)"
TEMP_DIRS+=("$canonical_dir")
canonical_output="$(run_action "$(build_doppler_secrets_json)" "$canonical_dir" api preview "https://static.vm0.io/okou-cli/test-sha/package.tgz" canonical 2>&1)"
canonical_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${canonical_dir}/github-output")"
assert_contains "$canonical_output" "Rendered"
assert_no_fixture_secret_values "$canonical_output"
assert_migrated_zero_outputs_absent "$canonical_env_file"
assert_migrated_okou_outputs_match "$success_env_file" "$canonical_env_file"

precedence_dir="$(mktemp -d)"
TEMP_DIRS+=("$precedence_dir")
precedence_output="$(run_action "$(build_doppler_secrets_json)" "$precedence_dir" api preview "https://static.vm0.io/okou-cli/test-sha/package.tgz" both 2>&1)"
precedence_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${precedence_dir}/github-output")"
assert_contains "$precedence_output" "Rendered"
assert_no_fixture_secret_values "$precedence_output"
assert_migrated_zero_outputs_absent "$precedence_env_file"
assert_env_value "$precedence_env_file" OKOU_WEATHER_GOOGLE_WEATHER_TOKEN "okou-google-weather-token"
assert_env_value "$precedence_env_file" OKOU_SEO_DATAFORSEO_LOGIN "okou-dataforseo-login"
assert_env_value "$precedence_env_file" OKOU_BROWSER_USE_API_KEY "okou-browser-use-api-key"
assert_env_value "$precedence_env_file" OKOU_HOST_DOMAIN "okou-sites.test"
assert_env_value "$precedence_env_file" OKOU_HOST_SCHEME "http"
assert_env_value "$precedence_env_file" OKOU_PRICE_PRO "price_okou_pro"
assert_env_value "$precedence_env_file" OKOU_ONE_TIME_CAMPAIGN "okou-campaign"

empty_dir="$(mktemp -d)"
TEMP_DIRS+=("$empty_dir")
empty_output="$(run_action "$(build_doppler_secrets_json)" "$empty_dir" api preview "https://static.vm0.io/okou-cli/test-sha/package.tgz" empty 2>&1)"
empty_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${empty_dir}/github-output")"
assert_contains "$empty_output" "Rendered"
assert_no_fixture_secret_values "$empty_output"
assert_migrated_zero_outputs_absent "$empty_env_file"
assert_env_value "$empty_env_file" OKOU_HOST_DOMAIN ""
assert_env_value "$empty_env_file" OKOU_MAPS_GOOGLE_MAPS_TOKEN ""
assert_env_value "$empty_env_file" OKOU_SEO_DATAFORSEO_LOGIN ""
assert_env_value "$empty_env_file" OKOU_PRICE_PRO ""
assert_env_value "$empty_env_file" OKOU_ONE_TIME_CAMPAIGN ""

production_web_dir="$(mktemp -d)"
TEMP_DIRS+=("$production_web_dir")
production_web_output="$(run_action "$(build_doppler_secrets_json)" "$production_web_dir" web production 2>&1)"
production_web_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${production_web_dir}/github-output")"
assert_contains "$production_web_output" "Rendered"
assert_no_fixture_secret_values "$production_web_output"
assert_migrated_zero_outputs_absent "$production_web_env_file"
assert_env_value "$production_web_env_file" POSTHOG_KEY "github-posthog-key"
assert_env_value "$production_web_env_file" POSTHOG_HOST "https://posthog.github.test"
assert_env_value "$production_web_env_file" GIT_COMMIT_SHA "$EXPECTED_BUILD_COMMIT_SHA"
assert_env_absent_value "$production_web_env_file" "ATOM_URL="
assert_env_absent_value "$production_web_env_file" "VM0_MACHINE_SECRET_KEY="
assert_env_absent_value "$production_web_env_file" "CLI_PKG_URL="
assert_env_absent_value "$production_web_env_file" "JOGGAI_WEBHOOK_SECRET="
assert_env_value "$production_web_env_file" OKOU_WEATHER_GOOGLE_WEATHER_TOKEN "github-google-weather-token"
assert_env_value "$production_web_env_file" OKOU_FINANCE_APIDOJO_TOKEN "github-apidojo-token"
assert_env_absent_value "$production_web_env_file" "OKOU_SEO_DATAFORSEO_LOGIN="
assert_env_absent_value "$production_web_env_file" "OKOU_SEO_DATAFORSEO_PASSWORD="
assert_env_value "$production_web_env_file" OKOU_SCRAPE_FIRECRAWL_TOKEN "github-firecrawl-token"
assert_env_value "$production_web_env_file" OKOU_WEB_SEARCH_PERPLEXITY_TOKEN "github-perplexity-token"
assert_env_absent_value "$production_web_env_file" "OKOU_BROWSER_USE_API_KEY="
assert_env_absent_value "$production_web_env_file" "github-cloudflare-browser-rendering-token"
assert_env_absent_value "$production_web_env_file" "github-artifact-preview-waf-secret"

canonical_production_web_dir="$(mktemp -d)"
TEMP_DIRS+=("$canonical_production_web_dir")
canonical_production_web_output="$(run_action "$(build_doppler_secrets_json)" "$canonical_production_web_dir" web production "" canonical 2>&1)"
canonical_production_web_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${canonical_production_web_dir}/github-output")"
assert_contains "$canonical_production_web_output" "Rendered"
assert_no_fixture_secret_values "$canonical_production_web_output"
assert_migrated_zero_outputs_absent "$canonical_production_web_env_file"
assert_migrated_okou_outputs_match "$production_web_env_file" "$canonical_production_web_env_file"

production_api_dir="$(mktemp -d)"
TEMP_DIRS+=("$production_api_dir")
production_api_output="$(run_action "$(build_doppler_secrets_json)" "$production_api_dir" api production 2>&1)"
production_api_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${production_api_dir}/github-output")"
assert_contains "$production_api_output" "Rendered"
assert_no_fixture_secret_values "$production_api_output"
assert_migrated_zero_outputs_absent "$production_api_env_file"
assert_env_value "$production_api_env_file" VM0_WEB_URL "https://pr-123-www.vm0.test"
assert_env_value "$production_api_env_file" VM0_API_BACKEND_URL "https://pr-123-api-backend.vm0.test"
assert_env_value "$production_api_env_file" FEISHU_CALLBACK_BASE_URL "https://pr-123-api-backend.vm0.test"
assert_env_value "$production_api_env_file" CLI_PKG_URL "https://static.vm0.io/okou-cli/test-sha/package.tgz"
assert_env_value "$production_api_env_file" ATOM_URL "https://atom.github.test"
assert_env_value "$production_api_env_file" VM0_MACHINE_SECRET_KEY "github-atom-machine-secret"
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
assert_env_absent_value "$production_api_env_file" "ONBOARDING_URL="
assert_env_value "$production_api_env_file" CLOUDFLARE_BROWSER_RENDERING_API_TOKEN "github-cloudflare-browser-rendering-token"
assert_env_value "$production_api_env_file" ARTIFACT_PREVIEW_WAF_SECRET "github-artifact-preview-waf-secret"
assert_env_value "$production_api_env_file" STRIPE_WEBHOOK_SECRET "github-stripe-billing-webhook-secret"
assert_env_value "$production_api_env_file" STRIPE_AUTOMATION_WEBHOOK_SECRET "github-stripe-automation-webhook-secret"
assert_env_absent_value "$production_api_env_file" "doppler-stripe-billing-webhook-secret"
assert_env_absent_value "$production_api_env_file" "doppler-stripe-automation-webhook-secret"

canonical_production_api_dir="$(mktemp -d)"
TEMP_DIRS+=("$canonical_production_api_dir")
canonical_production_api_output="$(run_action "$(build_doppler_secrets_json)" "$canonical_production_api_dir" api production "https://static.vm0.io/okou-cli/test-sha/package.tgz" canonical 2>&1)"
canonical_production_api_env_file="$(awk -F= '$1 == "file" { sub(/^[^=]*=/, ""); print }' "${canonical_production_api_dir}/github-output")"
assert_contains "$canonical_production_api_output" "Rendered"
assert_no_fixture_secret_values "$canonical_production_api_output"
assert_migrated_zero_outputs_absent "$canonical_production_api_env_file"
assert_migrated_okou_outputs_match "$production_api_env_file" "$canonical_production_api_env_file"

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
