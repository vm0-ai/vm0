#!/usr/bin/env bats

# Test experimental_firewall MITM mode (with HTTPS inspection)
#
# MITM mode decrypts and inspects HTTPS traffic, enabling:
# - Full HTTP request/response inspection
# - Secret sealing (vm0_enc_ prefix)
# - Detailed network logging
# - HTTP 403 response for blocked requests
#
# Prerequisites: runner must have mitmproxy installed with CA certificate

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
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_firewall:
      enabled: true
      experimental_mitm: true
      rules:
        - domain: "httpbin.org"
          action: ALLOW
        - final: DENY
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
}

@test "mitm-firewall: allowed domain passes through" {
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped"
    fi

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-allow:
    description: "MITM allow test"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_firewall:
      enabled: true
      experimental_mitm: true
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
}

@test "mitm-firewall: blocked domain returns 403" {
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped"
    fi

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-block:
    description: "MITM block test"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_firewall:
      enabled: true
      experimental_mitm: true
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
        "curl -sf https://example.com || echo 'BLOCKED'"

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"
    assert_output --partial "BLOCKED"
}

@test "mitm-firewall: seal_secrets encrypts environment secrets" {
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped"
    fi

    export TEST_SECRET="secret-$(date +%s%3N)-$RANDOM"

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-seal:
    description: "MITM seal_secrets test"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_firewall:
      enabled: true
      experimental_mitm: true
      experimental_seal_secrets: true
      rules:
        - domain: "httpbin.org"
          action: ALLOW
        - final: DENY
    environment:
      MY_SECRET: "\${{ secrets.MY_SECRET }}"
EOF

    create_artifact "$ARTIFACT_NAME-seal"

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    run $CLI_COMMAND run "${AGENT_NAME}-seal" \
        --artifact-name "$ARTIFACT_NAME-seal" \
        --secrets "MY_SECRET=$TEST_SECRET" \
        "echo \"VALUE=\$MY_SECRET\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # Secret should be encrypted with vm0_enc_ prefix
    assert_output --partial "VALUE=vm0_enc_"

    # Original secret value should NOT appear
    if [[ "$output" == *"$TEST_SECRET"* ]]; then
        fail "Original secret should not appear in output"
    fi
}

@test "mitm-firewall: secrets not encrypted without seal_secrets" {
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped"
    fi

    export TEST_SECRET="plain-$(date +%s%3N)-$RANDOM"

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-noseal:
    description: "MITM without seal_secrets"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_firewall:
      enabled: true
      experimental_mitm: true
      experimental_seal_secrets: false
      rules:
        - domain: "httpbin.org"
          action: ALLOW
        - final: DENY
    environment:
      MY_SECRET: "\${{ secrets.MY_SECRET }}"
EOF

    create_artifact "$ARTIFACT_NAME-noseal"

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    run $CLI_COMMAND run "${AGENT_NAME}-noseal" \
        --artifact-name "$ARTIFACT_NAME-noseal" \
        --secrets "MY_SECRET=$TEST_SECRET" \
        "echo \"VALUE=\$MY_SECRET\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # Secret should NOT be encrypted with vm0_enc_ prefix when seal_secrets is disabled
    # Note: CLI masks secret values in output (shows ***) for security, but the actual
    # value passed to the agent is not encrypted
    if [[ "$output" == *"VALUE=vm0_enc_"* ]]; then
        fail "Secret should not be encrypted when seal_secrets is disabled"
    fi
}

@test "mitm-firewall: network logs capture requests" {
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped"
    fi

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-logs:
    description: "MITM network logs test"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_firewall:
      enabled: true
      experimental_mitm: true
      rules:
        - domain: "httpbin.org"
          action: ALLOW
        - final: DENY
EOF

    create_artifact "$ARTIFACT_NAME-logs"

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    run $CLI_COMMAND run "${AGENT_NAME}-logs" \
        --artifact-name "$ARTIFACT_NAME-logs" \
        "curl --retry 3 -sf https://httpbin.org/get >/dev/null 2>&1 || true; echo 'done'"

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # Extract run ID
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || fail "Failed to extract Run ID"

    # Fetch network logs with retries
    for i in {1..5}; do
        run $CLI_COMMAND logs "$RUN_ID" --network --tail 100
        if [[ "$output" == *"httpbin.org"* ]]; then
            echo "Network logs found"
            return 0
        fi
        sleep 2
    done

    fail "Network logs not found"
}
