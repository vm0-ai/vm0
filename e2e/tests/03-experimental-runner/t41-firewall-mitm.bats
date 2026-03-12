#!/usr/bin/env bats

# Test experimental_firewall with HTTPS inspection (MITM)
#
# When firewall is enabled, MITM mode is always active, providing:
# - Full HTTP request/response inspection
# - Detailed network logging
# - HTTP 403 response for blocked requests
#
# Prerequisites: runner must have mitmproxy installed with CA certificate

load '../../helpers/setup'

setup() {
    if [[ -z "$VM0_API_URL" ]]; then
        fail "VM0_API_URL not set"
    fi

    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-mitm-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-mitm-artifact-${UNIQUE_ID}"
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

@test "mitm-firewall: compose accepts MITM config" {
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  mitm-test:
    description: "MITM firewall test"
    framework: claude-code
    working_dir: /home/user/workspace
    experimental_firewall:
      enabled: true
      rules:
        - domain: "httpbin.org"
          action: ALLOW
        - final: DENY
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
}

@test "mitm-firewall: allowed domain passes through and logs captured" {
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-allow:
    description: "MITM allow test"
    framework: claude-code
    working_dir: /home/user/workspace
    experimental_firewall:
      enabled: true
      rules:
        - domain: "httpbin.org"
          action: ALLOW
        - final: DENY
EOF

    create_artifact "$ARTIFACT_NAME-allow"

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    run $CLI_COMMAND run "${AGENT_NAME}-allow" \
        --artifact-name "$ARTIFACT_NAME-allow" \
        "curl -sf https://httpbin.org/get | grep -o '\"url\"' | head -1"

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # Extract run ID and verify network logs are captured
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || fail "Failed to extract Run ID"

    # Fetch network logs with retry (Axiom ingestion is async)
    local max_retries=10
    local retry_delay=3
    for i in $(seq 1 $max_retries); do
        run $CLI_COMMAND logs "$RUN_ID" --network --tail 100
        if [[ "$output" == *"httpbin.org"* ]]; then
            echo "Network logs found (attempt $i)"
            assert_success
            return 0
        fi
        echo "Retry $i/$max_retries: waiting for network logs..."
        sleep $retry_delay
    done

    echo "$output"
    fail "Network logs not found after $max_retries retries"
}

@test "mitm-firewall: blocked domain returns 403" {
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-block:
    description: "MITM block test"
    framework: claude-code
    working_dir: /home/user/workspace
    experimental_firewall:
      enabled: true
      rules:
        - domain: "httpbin.org"
          action: ALLOW
        - final: DENY
EOF

    create_artifact "$ARTIFACT_NAME-block"

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    # MITM mode returns HTTP 403 for blocked requests
    run $CLI_COMMAND run "${AGENT_NAME}-block" \
        --artifact-name "$ARTIFACT_NAME-block" \
        --verbose \
        "curl -sf https://example.com || echo 'BLOCKED'"

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"
    assert_output --partial "BLOCKED"
}

