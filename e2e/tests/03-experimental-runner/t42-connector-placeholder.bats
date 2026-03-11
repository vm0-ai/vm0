#!/usr/bin/env bats

# Test experimental_services placeholder env var injection and token replacement
#
# Verifies that when experimental_services is declared:
# 1. Compose accepts the configuration
# 2. Placeholder env vars replace secret values in the sandbox (with custom formats)
# 3. Multiple connectors work together
# 4. Proxy replaces placeholder tokens with real tokens (via test-connector API)
#
# All tests require test-connector setup so the connector is "connected" in the DB,
# which is needed for placeholder injection via buildConnectorEnvVars.

load '../../helpers/setup'

setup() {
    if [[ -z "$VM0_API_URL" ]]; then
        fail "VM0_API_URL not set"
    fi

    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-connector-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-connector-artifact-${UNIQUE_ID}"
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
    $CLI_COMMAND artifact init --name "$name" >/dev/null 2>&1
    echo "test" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1
}

# Helper to set up a test connector with a known token via API
setup_test_connector() {
    local connector_name="$1"
    local access_token="$2"
    local variant="${3:-runner}"

    local curl_args=(-s -w "\n%{http_code}" -X POST)
    curl_args+=(-H "Content-Type: application/json")
    if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
        curl_args+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
    fi
    curl_args+=(-d "{\"connectorName\":\"${connector_name}\",\"accessToken\":\"${access_token}\"}")

    local response
    response=$(curl "${curl_args[@]}" \
        "${VM0_API_URL}/api/cli/auth/test-connector?variant=${variant}")

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

@test "connector: compose accepts experimental_services" {
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  connector-test:
    description: "Connector placeholder test"
    framework: claude-code
    working_dir: /home/user/workspace
    experimental_services:
      - github
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
}

@test "connector: github placeholder uses gho_ prefix" {
    setup_test_connector "github" "ghp_placeholder_test_token"

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-github:
    description: "GitHub connector placeholder test"
    framework: claude-code
    working_dir: /home/user/workspace
    experimental_services:
      - github
    environment:
      GH_TOKEN: \${{ secrets.GH_TOKEN }}
      GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
EOF

    create_artifact "$ARTIFACT_NAME-github"

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Verify GITHUB_TOKEN and GH_TOKEN are set to the connector placeholder.
    # Full values are masked by the runner (***), so we compare sha256 hashes.
    local expected_gh_hash
    expected_gh_hash=$(echo -n "gho_vm0placeholder0000000000000000000000" | sha256sum | cut -d' ' -f1)
    run $CLI_COMMAND run "${AGENT_NAME}-github" \
        --artifact-name "$ARTIFACT_NAME-github" \
        "echo \"GH_HASH=\$(echo -n \$GH_TOKEN | sha256sum | cut -d' ' -f1)\" && echo \"GITHUB_HASH=\$(echo -n \$GITHUB_TOKEN | sha256sum | cut -d' ' -f1)\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    assert_output --partial "GH_HASH=${expected_gh_hash}"
    assert_output --partial "GITHUB_HASH=${expected_gh_hash}"
}

@test "connector: multiple connectors inject all env vars" {
    setup_test_connector "github" "ghp_multi_test_token"
    setup_test_connector "slack" "xoxb-multi-test-token"

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-multi:
    description: "Multi-connector placeholder test"
    framework: claude-code
    working_dir: /home/user/workspace
    experimental_services:
      - github
      - slack
    environment:
      GH_TOKEN: \${{ secrets.GH_TOKEN }}
      SLACK_TOKEN: \${{ secrets.SLACK_TOKEN }}
EOF

    create_artifact "$ARTIFACT_NAME-multi"

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Verify env vars from both connectors via sha256 hash comparison.
    local expected_gh_hash
    expected_gh_hash=$(echo -n "gho_vm0placeholder0000000000000000000000" | sha256sum | cut -d' ' -f1)
    local expected_slack_hash
    expected_slack_hash=$(echo -n "xoxb-0000-0000-vm0placeholder" | sha256sum | cut -d' ' -f1)
    run $CLI_COMMAND run "${AGENT_NAME}-multi" \
        --artifact-name "$ARTIFACT_NAME-multi" \
        "echo \"GH_HASH=\$(echo -n \$GH_TOKEN | sha256sum | cut -d' ' -f1)\" && echo \"SLACK_HASH=\$(echo -n \$SLACK_TOKEN | sha256sum | cut -d' ' -f1)\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    assert_output --partial "GH_HASH=${expected_gh_hash}"
    assert_output --partial "SLACK_HASH=${expected_slack_hash}"
}

@test "connector: proxy replaces placeholder with real token" {
    if [[ -z "$CI_GITHUB_TOKEN" ]]; then
        fail "CI_GITHUB_TOKEN not set"
    fi

    # Use the real GitHub Actions token so we can verify the proxy
    # actually replaced the placeholder with a working token.
    setup_test_connector "github" "$CI_GITHUB_TOKEN"

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-replace:
    description: "Token replacement test"
    framework: claude-code
    working_dir: /home/user/workspace
    experimental_services:
      - github
    environment:
      GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
EOF

    create_artifact "$ARTIFACT_NAME-replace"

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Make a request to the GitHub API from inside the sandbox.
    # The sandbox only has the placeholder token (gho_vm0placeholder...).
    # The proxy intercepts the request, replaces it with the real
    # CI_GITHUB_TOKEN, and forwards to GitHub.
    #
    # 200 = proxy replaced the placeholder with the real token (success)
    # 401 = placeholder was sent as-is (replacement did NOT happen)
    run $CLI_COMMAND run "${AGENT_NAME}-replace" \
        --artifact-name "$ARTIFACT_NAME-replace" \
        "STATUS=\$(curl -s -o /dev/null -w '%{http_code}' https://api.github.com/repos/vm0-ai/vm0) && echo \"HTTP_STATUS=\$STATUS\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    assert_output --partial "HTTP_STATUS=200"
}
