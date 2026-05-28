#!/usr/bin/env bats

# Test firewall placeholder env var injection and connector auto-add
#
# Verifies that:
# 1. Placeholder env vars replace secret values in the sandbox (with custom formats)
# 2. Connector auto-add provides firewalls with unrestricted access

load '../../helpers/setup'

# Set up connectors ONCE before parallel tests to avoid race conditions.
# Both tests write to the same connector record (orgId + userId + type),
# so concurrent setup_test_connector calls would overwrite each other.
setup_file() {
    if [[ -z "$VM0_API_URL" ]]; then
        echo "VM0_API_URL not set" >&2
        return 1
    fi
    if [[ -z "$CI_GITHUB_TOKEN" ]]; then
        echo "CI_GITHUB_TOKEN not set" >&2
        return 1
    fi

    setup_test_connector "github" "$CI_GITHUB_TOKEN"
    setup_test_connector "slack" "xoxb-multi-test-token"

    # discord-webhook uses api-token auth, so set it up through the same
    # connector-aware path as the frontend's "Add Connection" dialog.
    $ZERO_CLI connector connect discord-webhook \
        --value DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1234567890/fake-token-for-e2e
}

teardown_file() {
    zero_curl "/api/zero/connectors/discord-webhook" -X DELETE >/dev/null 2>&1 || true
}

setup() {
    if [[ -z "$VM0_API_URL" ]]; then
        fail "VM0_API_URL not set"
    fi

    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-firewall-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-firewall-artifact-${UNIQUE_ID}"
}

teardown() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# Helper to create artifact
create_artifact() {
    local name="$1"
    mkdir -p "$TEST_DIR/$name"
    cd "$TEST_DIR/$name"
    $VM0_CLI artifact init --name "$name" >/dev/null 2>&1
    echo "test" > test.txt
    $VM0_CLI artifact push >/dev/null 2>&1
}

# Helper to set up a test connector with a known token via API
setup_test_connector() {
    local connector_name="$1"
    local access_token="$2"

    if [[ -z "${E2E_RUNNER_EMAIL:-}" ]]; then
        echo "E2E_RUNNER_EMAIL not set" >&2
        return 1
    fi

    # URL-encode the email (handle + and @)
    local encoded_email
    encoded_email=$(printf '%s' "$E2E_RUNNER_EMAIL" | sed 's/+/%2B/g; s/@/%40/g')

    local curl_args=(-s -w "\n%{http_code}" -X POST)
    curl_args+=(-H "Content-Type: application/json")
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        curl_args+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
    curl_args+=(-d "{\"connectorName\":\"${connector_name}\",\"accessToken\":\"${access_token}\"}")

    local response
    response=$(curl "${curl_args[@]}" \
        "${VM0_API_URL}/api/cli/auth/test-connector?email=${encoded_email}")

    local http_code
    http_code=$(echo "$response" | tail -n1)
    local body
    body=$(echo "$response" | head -n-1)

    if [[ "$http_code" != "200" ]]; then
        echo "Failed to set up test connector: HTTP $http_code"
        echo "Response: $body"
        return 1
    fi
}

@test "firewall: placeholder env vars" {
    # Connectors are set up in setup_file() to avoid parallel write races.
    # No firewalls needed — connector auto-add provides firewalls.
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-multi:
    description: "Multi-firewall placeholder test"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      SLACK_TOKEN: \${{ secrets.SLACK_TOKEN }}
EOF

    create_artifact "$ARTIFACT_NAME-multi"

    run $VM0_CLI compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Verify env vars from both firewall configs are set to placeholder values.
    run $VM0_CLI run "${AGENT_NAME}-multi" \
        --artifact "$ARTIFACT_NAME-multi:/home/user/workspace" \
        "echo \"GITHUB_TOKEN=\$GITHUB_TOKEN\" && echo \"SLACK_TOKEN=\$SLACK_TOKEN\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    assert_output --partial "GITHUB_TOKEN=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"
    assert_output --partial "SLACK_TOKEN=xoxb-100100100100-1001001001001-CoffeeSafeLocalCoffeeSaf"
}

@test "firewall: connector auto-adds firewall without firewalls" {
    # GitHub connector is set up in setup_file().
    # Compose does NOT declare firewalls — the system should
    # auto-add a firewall for the connected GitHub connector with unrestricted access.
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-auto:
    description: "Auto-firewall connector test"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
EOF

    create_artifact "$ARTIFACT_NAME-auto"

    run $VM0_CLI compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Verify GITHUB_TOKEN is replaced with placeholder (firewall auto-added)
    # and a GitHub API call succeeds through the proxy (token replacement works).
    run $VM0_CLI run "${AGENT_NAME}-auto" \
        --artifact "$ARTIFACT_NAME-auto:/home/user/workspace" \
        "TOKEN_VAL=\$GITHUB_TOKEN && STARTS_WITH=\$(echo \$TOKEN_VAL | cut -c1-7) && STATUS=\$(curl -s -o /dev/null -w '%{http_code}' https://api.github.com/repos/vm0-ai/vm0) && echo \"PLACEHOLDER=\$STARTS_WITH\" && echo \"API_STATUS=\$STATUS\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # Token should be the placeholder (proxy will replace it with real token)
    assert_output --partial "PLACEHOLDER=gho_Cof"
    # API call should succeed (proxy replaced placeholder with real token)
    assert_output --partial "API_STATUS=200"

    # Verify token replacement details appear in network logs.
    # The CLI renders: ↔ GITHUB_TOKEN with optional (cached)/(refreshed) suffix.
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    wait_for_log "$RUN_ID" --network -- "GITHUB_TOKEN"
}

@test "firewall: auth.base placeholder for webhook-url connector" {
    # discord-webhook connector is set up in setup_file().
    # Its firewall uses auth.base (URL rewriting) instead of auth.headers.
    # The placeholder is a firewall-placeholder.vm3.ai URL, not a token string.
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-webhook:
    description: "Webhook URL placeholder test"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      DISCORD_WEBHOOK_URL: \${{ secrets.DISCORD_WEBHOOK_URL }}
EOF

    create_artifact "$ARTIFACT_NAME-webhook"

    run $VM0_CLI compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Verify:
    # 1. DISCORD_WEBHOOK_URL is set to the placeholder URL
    # 2. curl to the placeholder URL triggers mitmproxy URL rewrite
    # 3. Discord returns 404 (fake webhook ID) proving the request reached Discord
    run $VM0_CLI run "${AGENT_NAME}-webhook" \
        --artifact "$ARTIFACT_NAME-webhook:/home/user/workspace" \
        "echo \"DISCORD_WEBHOOK_URL=\$DISCORD_WEBHOOK_URL\" && curl -s -o /dev/null -w 'API_STATUS=%{http_code}\n' -X POST \"\$DISCORD_WEBHOOK_URL\" -H 'Content-Type: application/json' -d '{\"content\":\"e2e\"}'"

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # Placeholder is the firewall-placeholder.vm3.ai URL
    assert_output --partial "DISCORD_WEBHOOK_URL=https://firewall-placeholder.vm3.ai/discord-webhook/hook"

    # Discord returns 404 for the fake webhook — proves URL rewrite reached Discord.
    # May also return 429 (rate limited) which equally proves the request reached Discord.
    assert_output --regexp "API_STATUS=(404|429)"

    # Extract run ID
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    # Network logs prove mitmproxy matched the firewall and rewrote the URL
    wait_for_log "$RUN_ID" --network -- "[discord-webhook]" "url-rewrite"
}
