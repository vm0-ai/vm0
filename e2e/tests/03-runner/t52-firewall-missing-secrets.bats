#!/usr/bin/env bats

# Test firewall behavior when connector is enabled but not linked (no secrets).
#
# Verifies that when a user enables a connector for an agent without linking it
# (no OAuth/API token), the proxy returns 424 with connector_not_configured error
# instead of silently passing through or injecting empty auth headers.
#
# Uses the zero run path (not CLI run) because allowedConnectorTypes is only
# populated from user_connectors table in the zero/platform run flow.

load '../../helpers/setup'

setup_file() {
    if [[ -z "$VM0_API_URL" ]]; then
        echo "VM0_API_URL not set" >&2
        return 1
    fi

    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-missing-secrets-${UNIQUE_ID}"
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# Enable a connector for an agent WITHOUT linking it (no OAuth, no secrets).
# Uses the test-enable-connector endpoint which inserts user_connectors rows
# and ensures the zeroAgents FK target exists.
enable_test_connector() {
    local compose_id="$1"
    local connector_type="$2"

    if [[ -z "${E2E_RUNNER_EMAIL:-}" ]]; then
        echo "E2E_RUNNER_EMAIL not set" >&2
        return 1
    fi

    local encoded_email
    encoded_email=$(printf '%s' "$E2E_RUNNER_EMAIL" | sed 's/+/%2B/g; s/@/%40/g')

    local curl_args=(-s -w "\n%{http_code}" -X POST)
    curl_args+=(-H "Content-Type: application/json")
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        curl_args+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
    curl_args+=(-d "{\"composeId\":\"${compose_id}\",\"connectorTypes\":[\"${connector_type}\"]}")

    local response
    response=$(curl "${curl_args[@]}" \
        "${VM0_API_URL}/api/cli/auth/test-enable-connector?email=${encoded_email}")

    local http_code
    http_code=$(echo "$response" | tail -n1)
    local body
    body=$(echo "$response" | head -n-1)

    if [[ "$http_code" != "200" ]]; then
        echo "Failed to enable connector ${connector_type} for compose ${compose_id}: HTTP $http_code"
        echo "Response: $body"
        return 1
    fi
}

@test "firewall: enabled connector without secrets returns connector_not_configured" {
    # Skip: zero run requires org context which the e2e zero CLI doesn't have.
    # The CLI run path (vm0 run) doesn't read user_connectors, so it can't test
    # the new allowedConnectorTypes behavior. This test will be enabled when the
    # CLI run path also supports allowedConnectorTypes, or when e2e zero CLI
    # auth is configured with org context.
    skip "zero run org context not available in e2e environment"
    # Step 1: Compose an agent
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "Missing secrets firewall test"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
EOF

    run $VM0_CLI compose --yes --json "$TEST_DIR/vm0.yaml"
    echo "$output"
    assert_success

    # Extract composeId (= agent ID for zero run)
    local COMPOSE_ID
    COMPOSE_ID=$(echo "$output" | python3 -c "import sys,json; print(json.load(sys.stdin)['composeId'])")
    [ -n "$COMPOSE_ID" ] || {
        echo "# Failed to extract composeId from compose output"
        return 1
    }

    # Step 2: Enable github connector WITHOUT linking it (no secrets).
    run enable_test_connector "$COMPOSE_ID" "github"
    echo "$output"
    assert_success

    # Step 3: Run via zero path (reads user_connectors for allowedConnectorTypes).
    # The agent curls api.github.com — proxy matches github firewall, tries
    # to resolve auth, discovers secret is missing, returns 424.
    run $ZERO_CLI run "$COMPOSE_ID" \
        "curl -s -w '\n%{http_code}' https://api.github.com/repos/vm0-ai/vm0"

    echo "$output"
    assert_success

    # Proxy should return 424 with connector_not_configured
    assert_output --partial "424"
    assert_output --partial "connector_not_configured"
}
