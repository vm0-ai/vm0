#!/usr/bin/env bats

# Test experimental_firewalls placeholder env var injection and permission-based matching
#
# Verifies that when experimental_firewalls is declared:
# 1. Placeholder env vars replace secret values in the sandbox (with custom formats)
# 2. Proxy replaces placeholder tokens and enforces permission-based access control

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

@test "firewall: placeholder env vars" {
    # Connectors are set up in setup_file() to avoid parallel write races.
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-multi:
    description: "Multi-firewall placeholder test"
    framework: claude-code
    working_dir: /home/user/workspace
    experimental_firewalls:
      github:
        permissions: all
      slack:
        permissions: all
    environment:
      GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      SLACK_TOKEN: \${{ secrets.SLACK_TOKEN }}
EOF

    create_artifact "$ARTIFACT_NAME-multi"

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Verify env vars from both firewall configs are set to placeholder values.
    run $CLI_COMMAND run "${AGENT_NAME}-multi" \
        --artifact-name "$ARTIFACT_NAME-multi" \
        "echo \"GITHUB_TOKEN=\$GITHUB_TOKEN\" && echo \"SLACK_TOKEN=\$SLACK_TOKEN\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    assert_output --partial "GITHUB_TOKEN=gho_Vm0PlaceHolder0000000000000000000000"
    assert_output --partial "SLACK_TOKEN=xoxb-0000-0000-Vm0PlaceHolder0000000000"
}

@test "firewall: permission-based request matching" {
    # Connectors are set up in setup_file() to avoid parallel write races.
    # Only grant repo-read — search endpoints should be blocked.
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-perm:
    description: "Permission-based request matching test"
    framework: claude-code
    working_dir: /home/user/workspace
    experimental_firewalls:
      github:
        permissions:
          - metadata-read
    environment:
      GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
EOF

    create_artifact "$ARTIFACT_NAME-perm"

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Three checks from inside the sandbox:
    # 1. GET /repos/vm0-ai/vm0 — matches repo-read → proxy replaces token → 200
    # 2. GET /search/code?q=vm0 — no matching permission → mitm_addon blocks → 403
    # This also verifies proxy token replacement (200 means the real token was used).
    run $CLI_COMMAND run "${AGENT_NAME}-perm" \
        --artifact-name "$ARTIFACT_NAME-perm" \
        "ALLOWED=\$(curl -s -o /dev/null -w '%{http_code}' https://api.github.com/repos/vm0-ai/vm0) && BLOCKED=\$(curl -s -o /dev/null -w '%{http_code}' https://api.github.com/search/code?q=vm0) && echo \"ALLOWED_STATUS=\$ALLOWED\" && echo \"BLOCKED_STATUS=\$BLOCKED\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    assert_output --partial "ALLOWED_STATUS=200"
    assert_output --partial "BLOCKED_STATUS=403"
}
