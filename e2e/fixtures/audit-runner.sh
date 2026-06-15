#!/bin/bash
# Sandbox secret-leak audit script for the ChatGPT-OAuth Codex flow.
#
# Mounted into the sandbox as an artifact at /artifacts/audit-runner.sh.
# Run via the agent's Bash tool with the four real OAuth token strings as
# positional args. Outputs a single JSON document to stdout.
#
# Asserts the bedrock of Epic #11872 Success Criteria #4 + #5: real OAuth
# token strings (access_token, refresh_token, account_id, id_token) MUST
# NOT appear anywhere in:
#   1. process env (var values; not just names)
#   2. ~/.codex/auth.json contents
#   3. sandbox writable filesystem (logs, json, txt, env files in /home /tmp /var)
#   4. agent stdout/stderr if captured (covered by the agent test harness
#      grepping the agent run output for these strings — out-of-band)
#
# Plus surfaces:
#   - auth.json's auth_mode + decoded access_token chatgpt_account_id claim
#     (must be the placeholder, NOT the real account id)
#   - OPENAI_API_KEY value inside auth.json (must be null in ChatGPT mode)
#   - CODEX_REFRESH_TOKEN_URL_OVERRIDE env var (must be the no-op localhost URL)
#
# Usage:
#   audit-runner.sh <real_access_token> <real_refresh_token> <real_account_id> <real_id_token> [<auth_json_blob_prefix>] [<workspace_name>]
#
# auth_json_blob_prefix: optional. First ~50 chars of the raw codex auth.json
#   used to seed the provider via the paste flow. Catches "entire blob got
#   logged" leaks that the per-token scans would still pass (since they only
#   match individual claim values). Pass an empty string to skip.
# workspace_name: optional. Synthetic high-entropy workspace_name claim from
#   the id_token. Catches leaks of derived metadata. Pass an empty string to
#   skip.
#
# plan_type is intentionally NOT scanned — its values ("plus", "pro",
# "enterprise") are low-entropy English words that would false-positive on
# any unrelated env or file content.
#
# Exit code: always 0 (the bats test makes the assertion on the JSON output
# so a failed audit is a test failure, not a script failure).

set -e

real_access="$1"
real_refresh="$2"
real_account="$3"
real_id="$4"
auth_json_blob_prefix="${5:-}"
workspace_name="${6:-}"

auth_json_path="$HOME/.codex/auth.json"
auth_mode="missing"
auth_account_id="missing"
openai_api_key="missing"
auth_json_exists="false"

if [ -f "$auth_json_path" ]; then
    auth_json_exists="true"
    auth_mode=$(jq -r '.auth_mode // "null"' "$auth_json_path" 2>/dev/null || echo "parse_error")
    openai_api_key=$(jq -r '.OPENAI_API_KEY // "null"' "$auth_json_path" 2>/dev/null || echo "parse_error")

    # Decode access_token JWT payload to read chatgpt_account_id claim
    access_jwt=$(jq -r '.tokens.access_token // ""' "$auth_json_path" 2>/dev/null || echo "")
    if [ -n "$access_jwt" ]; then
        payload_b64=$(echo "$access_jwt" | cut -d. -f2)
        # Pad for base64 decode
        pad=$(( (4 - ${#payload_b64} % 4) % 4 ))
        if [ "$pad" -gt 0 ]; then
            padding=$(printf '%.0s=' $(seq 1 "$pad"))
            payload_b64="${payload_b64}${padding}"
        fi
        payload_json=$(echo "$payload_b64" | tr '_-' '/+' | base64 -d 2>/dev/null || echo "{}")
        auth_account_id=$(echo "$payload_json" | jq -r '."https://api.openai.com/auth".chatgpt_account_id // "null"' 2>/dev/null || echo "decode_error")
    fi
fi

# Collect env var NAMES matching CHATGPT_*/OPENAI_* (names only — values are scanned for forbidden hits below)
env_var_names=$(env | cut -d= -f1 | grep -E '^(CHATGPT|OPENAI)_' | sort -u | jq -Rs 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

codex_refresh_override=$(printenv CODEX_REFRESH_TOKEN_URL_OVERRIDE 2>/dev/null || echo "missing")

# Forbidden-string scan. Returns a JSON array of {location, snippet} objects.
# Each "snippet" is just the string label (access_token / refresh_token /
# account_id / id_token) so the actual real values don't echo back into logs
# (defense in depth — we don't want our own audit to leak the value we're
# trying to prove doesn't leak).
forbidden_hits='[]'

scan_for_value() {
    local value="$1"
    local label="$2"

    # Empty value = caller didn't provide; skip without recording.
    [ -z "$value" ] && return

    # 1. auth.json contents
    if [ "$auth_json_exists" = "true" ] && grep -qF -- "$value" "$auth_json_path" 2>/dev/null; then
        forbidden_hits=$(echo "$forbidden_hits" | jq --arg loc "auth.json" --arg snip "$label" '. + [{location: $loc, snippet: $snip}]')
    fi

    # 2. Env var values (env emits NAME=VALUE; grep matches across the line)
    if env | grep -qF -- "$value"; then
        forbidden_hits=$(echo "$forbidden_hits" | jq --arg loc "env" --arg snip "$label" '. + [{location: $loc, snippet: $snip}]')
    fi

    # 3. Files in writable paths. Limit to common log/config extensions and
    # cap depth to keep this fast — full FS scan is too slow for E2E runtime.
    while IFS= read -r f; do
        if grep -qF -- "$value" "$f" 2>/dev/null; then
            forbidden_hits=$(echo "$forbidden_hits" | jq --arg loc "file:$f" --arg snip "$label" '. + [{location: $loc, snippet: $snip}]')
        fi
    done < <(find /home /tmp /var -maxdepth 5 -type f \
        \( -name '*.log' -o -name '*.txt' -o -name '*.json' -o -name '*.env' -o -name 'auth.json' \) \
        2>/dev/null | head -100)
}

scan_for_value "$real_access" "access_token"
scan_for_value "$real_refresh" "refresh_token"
scan_for_value "$real_account" "account_id"
scan_for_value "$real_id" "id_token"
scan_for_value "$auth_json_blob_prefix" "auth_json_blob"
scan_for_value "$workspace_name" "workspace_name"

# Emit single-line compact JSON (small + easier to extract from agent output).
jq -nc \
    --arg auth_json_exists "$auth_json_exists" \
    --arg auth_mode "$auth_mode" \
    --arg auth_account_id "$auth_account_id" \
    --arg openai_api_key "$openai_api_key" \
    --argjson env_var_names "$env_var_names" \
    --arg codex_refresh_override "$codex_refresh_override" \
    --argjson forbidden_hits "$forbidden_hits" \
    '{authJsonExists: $auth_json_exists, authMode: $auth_mode, authJsonAccountId: $auth_account_id, openaiApiKeyInAuthJson: $openai_api_key, envVarNames: $env_var_names, codexRefreshOverrideUrl: $codex_refresh_override, forbiddenHits: $forbidden_hits}'
