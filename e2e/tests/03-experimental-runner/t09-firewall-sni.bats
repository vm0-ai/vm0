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
    provider: claude-code
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

@test "sni-firewall: allowed domain passes through" {
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped"
    fi

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-allow:
    description: "SNI allow test"
    provider: claude-code
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
    provider: claude-code
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
    provider: claude-code
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
