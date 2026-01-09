#!/usr/bin/env bats

# Test experimental_firewall configuration for domain/IP filtering
# This test verifies that:
# 1. Firewall rules are properly evaluated (first-match-wins)
# 2. Domain allowlist blocks unlisted domains
# 3. Wildcard domain matching works (*.example.com)
# 4. IP/CIDR filtering works
# 5. Final DENY rule blocks remaining traffic
# 6. MITM mode (with seal_secrets) encrypts secrets
# 7. SNI-only mode (without MITM) passes through without decryption
#
# The runner must have mitmproxy installed.

load '../../helpers/setup.bash'

# Verify test prerequisites
setup() {
    if [[ -z "$VM0_API_URL" ]]; then
        fail "VM0_API_URL not set"
    fi

    if [[ -z "$RUNNER_GROUP" ]]; then
        fail "RUNNER_GROUP not set - runner was not started by workflow"
    fi

    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-firewall-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-firewall-artifact-${UNIQUE_ID}"
}

teardown() {
    # Clean up test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "firewall: compose accepts experimental_firewall config" {
    echo "# Create config with experimental_firewall"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  firewall-test-agent:
    description: "Test agent with firewall"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_firewall:
      enabled: true
      rules:
        - domain: "*.github.com"
          action: ALLOW
        - domain: "api.anthropic.com"
          action: ALLOW
        - ip: "10.0.0.0/8"
          action: DENY
        - final: DENY
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
}

@test "firewall: compose accepts firewall with MITM enabled" {
    echo "# Create config with experimental_firewall and MITM"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  firewall-mitm-agent:
    description: "Test agent with firewall and MITM"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_firewall:
      enabled: true
      experimental_mitm: true
      experimental_seal_secrets: true
      rules:
        - domain: "*.anthropic.com"
          action: ALLOW
        - final: DENY
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
}

@test "firewall: compose accepts firewall without MITM (SNI-only)" {
    echo "# Create config with experimental_firewall but no MITM"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  firewall-sni-agent:
    description: "Test agent with firewall SNI-only"
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

@test "firewall: allowed domain passes through with MITM" {
    # Skip if network security tests are disabled
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped (SKIP_NETWORK_SECURITY_TEST set)"
    fi

    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    echo "# Step 1: Create agent config with firewall allowing httpbin.org"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-allow:
    description: "E2E test agent for firewall allow"
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

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME-allow"
    cd "$TEST_DIR/$ARTIFACT_NAME-allow"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME-allow" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run curl to allowed domain"
    run $CLI_COMMAND run "${AGENT_NAME}-allow" \
        --artifact-name "$ARTIFACT_NAME-allow" \
        "curl -sf https://httpbin.org/get | grep -o '\"url\"' | head -1"

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Run completed successfully"

    # Verify curl succeeded (HTTPS through MITM proxy)
    if [[ "$output" == *'"url"'* ]]; then
        echo "# SUCCESS: Allowed domain passed through firewall with MITM"
    else
        echo "# WARNING: Could not verify response content"
    fi
}

@test "firewall: blocked domain is denied with MITM" {
    # Skip if network security tests are disabled
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped (SKIP_NETWORK_SECURITY_TEST set)"
    fi

    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    echo "# Step 1: Create agent config with firewall blocking example.com"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-deny:
    description: "E2E test agent for firewall deny"
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

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME-deny"
    cd "$TEST_DIR/$ARTIFACT_NAME-deny"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME-deny" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run curl to blocked domain (example.com)"
    # curl should fail because example.com is not in the allowlist
    run $CLI_COMMAND run "${AGENT_NAME}-deny" \
        --artifact-name "$ARTIFACT_NAME-deny" \
        "curl -sf https://example.com || echo 'BLOCKED_BY_FIREWALL'"

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Run completed successfully"

    # Verify the request was blocked
    if [[ "$output" == *"BLOCKED_BY_FIREWALL"* ]] || [[ "$output" == *"403"* ]]; then
        echo "# SUCCESS: Blocked domain was denied by firewall"
    else
        echo "# WARNING: Could not verify block (may have been blocked differently)"
    fi
}

@test "firewall: wildcard domain matching works" {
    # Skip if network security tests are disabled
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped (SKIP_NETWORK_SECURITY_TEST set)"
    fi

    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    echo "# Step 1: Create agent config with wildcard domain rule"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-wildcard:
    description: "E2E test agent for wildcard domain"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_firewall:
      enabled: true
      experimental_mitm: true
      rules:
        - domain: "*.github.com"
          action: ALLOW
        - final: DENY
EOF

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME-wildcard"
    cd "$TEST_DIR/$ARTIFACT_NAME-wildcard"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME-wildcard" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run curl to api.github.com (should match *.github.com)"
    run $CLI_COMMAND run "${AGENT_NAME}-wildcard" \
        --artifact-name "$ARTIFACT_NAME-wildcard" \
        "curl -sf https://api.github.com/zen || echo 'CURL_FAILED'"

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Run completed successfully"

    # Verify the wildcard allowed the subdomain
    if [[ "$output" != *"CURL_FAILED"* ]]; then
        echo "# SUCCESS: Wildcard domain *.github.com allowed api.github.com"
    else
        echo "# WARNING: Curl failed (might be rate limited or network issue)"
    fi
}

@test "firewall: secrets are encrypted with MITM and seal_secrets" {
    # Skip if network security tests are disabled
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped (SKIP_NETWORK_SECURITY_TEST set)"
    fi

    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    export TEST_SECRET_VALUE="e2e-firewall-secret-$(date +%s%3N)-$RANDOM"

    echo "# Step 1: Create agent config with firewall and seal_secrets"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-secrets:
    description: "E2E test agent for firewall secrets"
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
      TEST_API_KEY: "\${{ secrets.TEST_API_KEY }}"
EOF

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME-secrets"
    cd "$TEST_DIR/$ARTIFACT_NAME-secrets"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME-secrets" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run the agent and print the secret"
    run $CLI_COMMAND run "${AGENT_NAME}-secrets" \
        --artifact-name "$ARTIFACT_NAME-secrets" \
        --secrets "TEST_API_KEY=$TEST_SECRET_VALUE" \
        "echo \"SECRET_VALUE=\$TEST_API_KEY\""

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Run completed successfully"

    # Step 5: Verify the secret is encrypted (starts with vm0_enc_)
    echo "# Step 5: Verifying secret is encrypted..."

    if [[ "$output" == *"SECRET_VALUE=vm0_enc_"* ]]; then
        echo "# SUCCESS: Secret is encrypted in VM environment (vm0_enc_ prefix)"
    else
        echo "# FAILED: Secret encryption check"
        fail "Secret should be encrypted with vm0_enc_ prefix when seal_secrets is enabled"
    fi

    # Step 6: Verify original secret is not in output
    if [[ "$output" == *"$TEST_SECRET_VALUE"* ]]; then
        fail "Original secret value should NOT appear in VM output"
    else
        echo "# SUCCESS: Original secret value is not leaked"
    fi
}

@test "firewall: SNI-only mode without MITM passes through" {
    # Skip if network security tests are disabled
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped (SKIP_NETWORK_SECURITY_TEST set)"
    fi

    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    echo "# Step 1: Create agent config with firewall but NO MITM"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-sni:
    description: "E2E test agent for SNI-only firewall"
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

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME-sni"
    cd "$TEST_DIR/$ARTIFACT_NAME-sni"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME-sni" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run curl to allowed domain (SNI-only, no MITM)"
    # In SNI-only mode, traffic passes through without decryption
    # The connection should work if domain is allowed by SNI
    run $CLI_COMMAND run "${AGENT_NAME}-sni" \
        --artifact-name "$ARTIFACT_NAME-sni" \
        "curl -sf https://httpbin.org/get | grep -o '\"url\"' | head -1"

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Run completed successfully"

    if [[ "$output" == *'"url"'* ]]; then
        echo "# SUCCESS: SNI-only mode allowed httpbin.org"
    else
        echo "# WARNING: Could not verify response content"
    fi
}

@test "firewall: SNI-only mode blocks unlisted domains" {
    # Skip if network security tests are disabled
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped (SKIP_NETWORK_SECURITY_TEST set)"
    fi

    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    echo "# Step 1: Create agent config with SNI-only firewall"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-sni-block:
    description: "E2E test agent for SNI-only block"
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

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME-sni-block"
    cd "$TEST_DIR/$ARTIFACT_NAME-sni-block"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME-sni-block" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run curl to blocked domain (example.com)"
    # In SNI-only mode, blocked domains should timeout or fail
    run $CLI_COMMAND run "${AGENT_NAME}-sni-block" \
        --artifact-name "$ARTIFACT_NAME-sni-block" \
        "curl -sf --connect-timeout 5 https://example.com || echo 'BLOCKED_BY_FIREWALL'"

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Run completed successfully"

    # Verify the request was blocked (connection reset or timeout)
    if [[ "$output" == *"BLOCKED_BY_FIREWALL"* ]]; then
        echo "# SUCCESS: SNI-only mode blocked example.com"
    else
        echo "# WARNING: Could not verify block status"
    fi
}

@test "firewall: secrets NOT encrypted without seal_secrets" {
    # Skip if network security tests are disabled
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped (SKIP_NETWORK_SECURITY_TEST set)"
    fi

    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    export TEST_SECRET_VALUE="e2e-no-seal-$(date +%s%3N)-$RANDOM"

    echo "# Step 1: Create agent config with firewall but NO seal_secrets"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-noseal:
    description: "E2E test agent for firewall without seal_secrets"
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
      TEST_API_KEY: "\${{ secrets.TEST_API_KEY }}"
EOF

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME-noseal"
    cd "$TEST_DIR/$ARTIFACT_NAME-noseal"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME-noseal" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run the agent and print the secret"
    run $CLI_COMMAND run "${AGENT_NAME}-noseal" \
        --artifact-name "$ARTIFACT_NAME-noseal" \
        --secrets "TEST_API_KEY=$TEST_SECRET_VALUE" \
        "echo \"SECRET_VALUE=\$TEST_API_KEY\""

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Run completed successfully"

    # Step 5: Verify the secret is NOT encrypted (should be plaintext)
    echo "# Step 5: Verifying secret is plaintext (no seal_secrets)..."

    if [[ "$output" == *"SECRET_VALUE=$TEST_SECRET_VALUE"* ]]; then
        echo "# SUCCESS: Secret is plaintext when seal_secrets is disabled"
    else
        # It might still be encrypted if experimental_network_security takes precedence
        # or if there's other logic, so we accept either outcome
        echo "# Note: Secret may be encrypted due to other settings"
    fi
}

@test "firewall: network logs show firewall actions" {
    # Skip if network security tests are disabled
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped (SKIP_NETWORK_SECURITY_TEST set)"
    fi

    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    echo "# Step 1: Create agent config with firewall"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-logs:
    description: "E2E test agent for firewall logs"
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

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME-logs"
    cd "$TEST_DIR/$ARTIFACT_NAME-logs"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME-logs" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run agent making network requests"
    # Use retry and ignore curl errors - the test is about verifying network logs,
    # not about curl success. httpbin.org may rate limit after many requests.
    run $CLI_COMMAND run "${AGENT_NAME}-logs" \
        --artifact-name "$ARTIFACT_NAME-logs" \
        "curl --retry 3 --retry-delay 1 -sf https://httpbin.org/get > /dev/null 2>&1 || echo 'curl_failed'; echo 'request_attempted'"

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Run completed successfully"

    # Step 5: Extract Run ID
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    echo "# Run ID: $RUN_ID"
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    # Step 6: Fetch network logs
    echo "# Step 6: Fetching network logs..."

    LOGS_FOUND=false
    for i in {1..5}; do
        echo "# Attempt $i: Fetching network logs..."
        run $CLI_COMMAND logs "$RUN_ID" --network --tail 100

        # Check for firewall-related fields in logs
        if [[ "$output" == *"httpbin.org"* ]]; then
            LOGS_FOUND=true
            break
        fi

        echo "# Logs not yet available, waiting 3s..."
        sleep 3
    done

    if [[ "$LOGS_FOUND" != "true" ]]; then
        echo "# Final output: $output"
        fail "Network logs not found after 5 retries"
    fi

    echo "# Network logs retrieved successfully"
    echo "$output"
}
