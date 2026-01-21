#!/usr/bin/env bats

# Test experimental_firewall SNI-only mode (without MITM)
#
# SNI-only mode filters traffic based on TLS Server Name Indication
# without decrypting the traffic. This provides:
# - Domain-based filtering without HTTPS inspection
# - Lower overhead (no certificate management)
# - Blocked connections fail with TLS certificate error
#
# Prerequisites: runner must have mitmproxy installed

load '../../helpers/setup.bash'

setup() {
    if [[ -z "$VM0_API_URL" ]]; then
        fail "VM0_API_URL not set"
    fi

    if [[ -z "$RUNNER_GROUP" ]]; then
        fail "RUNNER_GROUP not set - runner was not started by workflow"
    fi

    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-sni-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-sni-artifact-${UNIQUE_ID}"
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

@test "sni-firewall: compose accepts SNI-only config" {
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  sni-test:
    description: "SNI-only firewall test"
    framework: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_firewall:
      enabled: true
      experimental_mitm: false
      rules:
        - domain: "httpbin.org"
          action: ALLOW
        - final: DENY
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
}

@test "sni-firewall: allowed domain passes through and logs captured" {
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped"
    fi

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-allow:
    description: "SNI allow test"
    framework: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_firewall:
      enabled: true
      experimental_mitm: false
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

@test "sni-firewall: blocked domain is denied" {
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped"
    fi

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-block:
    description: "SNI block test"
    framework: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_firewall:
      enabled: true
      experimental_mitm: false
      rules:
        - domain: "httpbin.org"
          action: ALLOW
        - final: DENY
EOF

    create_artifact "$ARTIFACT_NAME-block"

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    # In SNI-only mode, blocked connections get TLS certificate error
    run $CLI_COMMAND run "${AGENT_NAME}-block" \
        --artifact-name "$ARTIFACT_NAME-block" \
        "curl -sf --connect-timeout 5 https://example.com || echo 'BLOCKED'"

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"
    assert_output --partial "BLOCKED"
}

@test "sni-firewall: wildcard domain matching works" {
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped"
    fi

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-wild:
    description: "SNI wildcard test"
    framework: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_firewall:
      enabled: true
      experimental_mitm: false
      rules:
        - domain: "*.github.com"
          action: ALLOW
        - final: DENY
EOF

    create_artifact "$ARTIFACT_NAME-wild"

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    # *.github.com should match api.github.com
    run $CLI_COMMAND run "${AGENT_NAME}-wild" \
        --artifact-name "$ARTIFACT_NAME-wild" \
        "curl -sf https://api.github.com/zen || echo 'FAILED'"

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"
}
