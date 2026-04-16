#!/usr/bin/env bats

# Test firewall behavior when connector is enabled but not linked (no secrets).
#
# Verifies that when a user enables a connector for an agent without linking it
# (no OAuth/API token), the proxy returns 424 with connector_not_configured error
# instead of silently passing through or injecting empty auth headers.

load '../../helpers/setup'

setup_file() {
    if [[ -z "$VM0_API_URL" ]]; then
        echo "VM0_API_URL not set" >&2
        return 1
    fi

    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-missing-secrets-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-missing-secrets-artifact-${UNIQUE_ID}"

    # Create artifact
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test" > test.txt
    $VM0_CLI artifact push >/dev/null 2>&1
    cd - >/dev/null
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# Helper to enable a connector for an agent via the user-connectors API.
# This enables the connector WITHOUT linking it (no OAuth, no secrets).
enable_connector_for_agent() {
    local agent_id="$1"
    local connector_type="$2"

    # Read auth token from CLI config
    local token
    token=$(python3 -c "import json; print(json.load(open('$HOME/.vm0/config.json'))['token'])" 2>/dev/null)
    if [[ -z "$token" ]]; then
        echo "No authToken in ~/.vm0/config.json" >&2
        return 1
    fi

    local curl_args=(-s -w "\n%{http_code}" -X PUT)
    curl_args+=(-H "Content-Type: application/json")
    curl_args+=(-H "Authorization: Bearer $token")
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        curl_args+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
    curl_args+=(-d "{\"enabledTypes\":[\"${connector_type}\"]}")

    local response
    response=$(curl "${curl_args[@]}" "${VM0_API_URL}/api/zero/agents/${agent_id}/user-connectors")

    local http_code
    http_code=$(echo "$response" | tail -n1)
    local body
    body=$(echo "$response" | head -n-1)

    if [[ "$http_code" != "200" ]]; then
        echo "Failed to enable connector ${connector_type} for agent ${agent_id}: HTTP $http_code"
        echo "Response: $body"
        return 1
    fi
}

@test "firewall: enabled connector without secrets returns connector_not_configured" {
    # Step 1: Compose an agent that references GITHUB_TOKEN
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

    # Extract composeId (= agent ID) from JSON output
    local COMPOSE_ID
    COMPOSE_ID=$(echo "$output" | python3 -c "import sys,json; print(json.load(sys.stdin)['composeId'])")
    [ -n "$COMPOSE_ID" ] || {
        echo "# Failed to extract composeId from compose output"
        return 1
    }

    # Step 2: Enable github connector for the agent WITHOUT linking it.
    # No setup_test_connector or secret set — github has no OAuth/API token.
    run enable_connector_for_agent "$COMPOSE_ID" "github"
    echo "$output"
    assert_success

    # Step 3: Run the agent, curl api.github.com through the proxy.
    # The proxy should match the github firewall rule, try to resolve auth,
    # discover the secret is missing, and return 424 connector_not_configured.
    run $VM0_CLI run "${AGENT_NAME}" \
        --artifact "$ARTIFACT_NAME" \
        "RESP=\$(curl -s -w '\\n%{http_code}' https://api.github.com/repos/vm0-ai/vm0) && BODY=\$(echo \"\$RESP\" | head -n-1) && STATUS=\$(echo \"\$RESP\" | tail -n1) && echo \"STATUS=\$STATUS\" && echo \"BODY=\$BODY\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # Proxy should return 424 (not 200, 401, or 403)
    assert_output --partial "STATUS=424"
    # Response body should contain the connector_not_configured error
    assert_output --partial "connector_not_configured"
}
