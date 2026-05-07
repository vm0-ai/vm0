#!/usr/bin/env bash
# Bats helper for sandbox secret-leak auditing during the ChatGPT-OAuth E2E.
#
# Loaded via `load '../../helpers/audit-sandbox'` from a bats test.
# Drives /artifacts/audit-runner.sh inside the sandbox via the agent's Bash
# tool, parses the JSON it emits, and exposes assertion functions for the
# load-bearing Epic SC #4 + #5 checks.

# Run audit-runner.sh inside the sandbox via the agent.
#
# Sandwich the JSON between sentinel markers so the bats parser can extract
# it reliably even if the LLM adds prose around the output.
#
# Pre-requisites (set by caller's setup_file):
#   $AGENT_NAME — composed agent name with audit artifact mounted at /artifacts/
#   $CHATGPT_AUDIT_FORBIDDEN_ACCESS_TOKEN
#   $CHATGPT_AUDIT_FORBIDDEN_REFRESH_TOKEN
#   $CHATGPT_AUDIT_FORBIDDEN_ACCOUNT_ID
#   $CHATGPT_AUDIT_FORBIDDEN_ID_TOKEN
#
# Side effects:
#   Sets AUDIT_JSON env var on success. Returns non-zero on failure.
audit_sandbox_via_agent() {
    local agent_name="$1"
    local artifact_path="${2:-/artifacts/audit-runner.sh}"

    if [ -z "${CHATGPT_AUDIT_FORBIDDEN_ACCESS_TOKEN:-}" ]; then
        echo "audit_sandbox_via_agent: CHATGPT_AUDIT_FORBIDDEN_* env vars not set" >&2
        return 1
    fi

    # Pass forbidden strings via single-quoted shell args inside the prompt.
    # Single quotes prevent shell expansion in the agent's literal Bash call.
    local prompt
    prompt=$(cat <<EOF
Run this exact Bash command and include its output between '---AUDIT-START---' and '---AUDIT-END---' markers in your response. Do not modify the command, do not add commentary inside the markers:

bash $artifact_path '${CHATGPT_AUDIT_FORBIDDEN_ACCESS_TOKEN}' '${CHATGPT_AUDIT_FORBIDDEN_REFRESH_TOKEN}' '${CHATGPT_AUDIT_FORBIDDEN_ACCOUNT_ID}' '${CHATGPT_AUDIT_FORBIDDEN_ID_TOKEN}'

After running, output exactly:
---AUDIT-START---
<paste the entire stdout above between the markers, on a single line>
---AUDIT-END---
EOF
)

    run "$VM0_CLI" run "$agent_name" -- "$prompt"
    if [ "$status" -ne 0 ]; then
        echo "Agent run failed (status=$status):" >&2
        echo "$output" >&2
        return 1
    fi

    # Extract the JSON payload between sentinel markers. Use awk for
    # multi-line tolerance — sed -n 's///p' only works on a single line.
    AUDIT_JSON=$(echo "$output" | awk '
        /---AUDIT-START---/ { in_block=1; next }
        /---AUDIT-END---/   { in_block=0; exit }
        in_block { print }
    ' | tr -d '\n' | sed 's/^ *//;s/ *$//')

    if [ -z "$AUDIT_JSON" ]; then
        echo "audit_sandbox_via_agent: could not extract audit JSON from agent output" >&2
        echo "Agent output was:" >&2
        echo "$output" >&2
        return 1
    fi

    # Validate parseable JSON.
    if ! echo "$AUDIT_JSON" | jq . >/dev/null 2>&1; then
        echo "audit_sandbox_via_agent: extracted output is not valid JSON" >&2
        echo "Extracted: $AUDIT_JSON" >&2
        return 1
    fi

    export AUDIT_JSON
}

# Assert no real-token strings appeared in any audited surface.
# This is THE load-bearing assertion for Epic SC #4 + #5.
assert_no_forbidden_hits() {
    local hits
    hits=$(echo "$AUDIT_JSON" | jq -r '.forbiddenHits | length')
    if [ "$hits" -gt 0 ]; then
        echo "FORBIDDEN STRING LEAK DETECTED IN SANDBOX:" >&2
        echo "$AUDIT_JSON" | jq '.forbiddenHits' >&2
        echo "(snippets are labels, not the leaked values; check seed env vars to identify which secret leaked)" >&2
        return 1
    fi
}

# Assert auth.json's decoded chatgpt_account_id claim is the placeholder.
# Catches the case where guest-agent's auth.json fabrication writes the real
# account id by accident.
assert_placeholder_account_id() {
    local actual
    actual=$(echo "$AUDIT_JSON" | jq -r '.authJsonAccountId')
    if [ "$actual" != "ws_VM0_PLACEHOLDER_DO_NOT_TRUST" ]; then
        echo "Expected auth.json access_token claim chatgpt_account_id='ws_VM0_PLACEHOLDER_DO_NOT_TRUST', got: $actual" >&2
        return 1
    fi
}

# Assert auth.json declares ChatGPT mode (not API-key mode).
assert_chatgpt_auth_mode() {
    local actual
    actual=$(echo "$AUDIT_JSON" | jq -r '.authMode')
    if [ "$actual" != "chatgpt" ]; then
        echo "Expected auth.json auth_mode='chatgpt', got: $actual" >&2
        return 1
    fi
}

# Assert auth.json's OPENAI_API_KEY field is null (one of three independent
# ChatGPT-mode signals — see crates/guest-agent/src/codex_auth.rs).
assert_openai_api_key_null() {
    local actual
    actual=$(echo "$AUDIT_JSON" | jq -r '.openaiApiKeyInAuthJson')
    if [ "$actual" != "null" ]; then
        echo "Expected auth.json OPENAI_API_KEY=null, got: $actual" >&2
        return 1
    fi
}

# Assert defense-in-depth env var is set (the no-op localhost URL that
# blocks any in-sandbox refresh attempt by codex).
assert_refresh_url_override_set() {
    local actual
    actual=$(echo "$AUDIT_JSON" | jq -r '.codexRefreshOverrideUrl')
    if [ "$actual" != "http://127.0.0.1:1/blocked" ]; then
        echo "Expected CODEX_REFRESH_TOKEN_URL_OVERRIDE='http://127.0.0.1:1/blocked', got: $actual" >&2
        return 1
    fi
}

# Out-of-band check: also grep the agent run output itself for forbidden
# strings. The audit script covers env / files / auth.json inside the
# sandbox; this catches leaks via stdout/stderr that the agent surfaces
# back through the run output stream.
#
# Caller passes the agent run output (typically `$output` from a `run` call).
assert_agent_output_no_forbidden_hits() {
    local agent_output="$1"
    local label hit
    for label in ACCESS_TOKEN REFRESH_TOKEN ACCOUNT_ID ID_TOKEN; do
        local var="CHATGPT_AUDIT_FORBIDDEN_${label}"
        local value="${!var:-}"
        [ -z "$value" ] && continue
        # grep -F = literal (not regex) — required for high-entropy random strings.
        if echo "$agent_output" | grep -qF -- "$value"; then
            echo "FORBIDDEN STRING LEAK IN AGENT OUTPUT: ${label}" >&2
            echo "(value redacted; check seed env var \$${var})" >&2
            return 1
        fi
    done
}
