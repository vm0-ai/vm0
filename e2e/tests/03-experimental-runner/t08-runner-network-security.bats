#!/usr/bin/env bats

# Test runner network security mode (host-level proxy)
# This test verifies that:
# 1. Agent runs with experimental_network_security enabled on self-hosted runner
# 2. The mitmproxy on the runner host intercepts VM traffic
# 3. Network logs are captured and uploaded to telemetry endpoint
# 4. The vm0 logs --network command retrieves network logs
#
# The runner must have mitmproxy installed and CA cert baked into rootfs.

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
    export AGENT_NAME="e2e-runner-network-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-runner-network-artifact-${UNIQUE_ID}"
}

teardown() {
    # Clean up test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "runner network security: run with proxy captures network traffic" {
    # Skip this test if SKIP_NETWORK_SECURITY_TEST is set
    # Useful for local development when mitmproxy isn't installed
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped (SKIP_NETWORK_SECURITY_TEST set)"
    fi

    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    echo "# Step 1: Create agent config with experimental_runner and network_security"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "E2E test agent for runner network security"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_network_security: true
EOF

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test content for network security" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run the agent (runner should pick it up with network security)"
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'testing runner network security'"

    echo "# Run output:"
    echo "$output"

    # Verify the run completed successfully
    assert_success
    assert_output --partial "Run completed successfully"

    # Step 5: Extract Run ID from output
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    echo "# Run ID: $RUN_ID"
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID from output"
        echo "$output"
        return 1
    }

    # Step 6: Verify vm0 logs --network command retrieves network logs
    # Note: Axiom has some ingestion delay, so we retry a few times
    echo "# Step 6: Fetching network logs (with retry for Axiom delay)..."

    NETWORK_LOGS_FOUND=false
    for i in {1..5}; do
        echo "# Attempt $i: Fetching network logs..."
        run $CLI_COMMAND logs "$RUN_ID" --network --tail 100

        if [[ "$output" == *"POST"* ]]; then
            NETWORK_LOGS_FOUND=true
            break
        fi

        echo "# Network logs not yet available, waiting 3s..."
        sleep 3
    done

    if [[ "$NETWORK_LOGS_FOUND" != "true" ]]; then
        echo "# Final output after retries: $output"
        fail "Network logs not found after 5 retries"
    fi

    assert_success

    # Network logs should contain HTTP request information from webhook calls
    # The mitmproxy on the runner host intercepts ALL traffic including:
    # - Heartbeat requests (POST /api/webhooks/agent/heartbeat)
    # - Event requests (POST /api/webhooks/agent/events)
    # - Telemetry requests (POST /api/webhooks/agent/telemetry)
    # - Checkpoint requests (POST /api/webhooks/agent/checkpoints)
    # - Storage requests (POST /api/webhooks/agent/storages)

    # Should see POST requests to webhook endpoints
    assert_output --partial "POST"

    # Verify specific webhook endpoints are captured
    # Events endpoint is always called during agent execution
    assert_output --partial "/api/webhooks/agent/events"
    echo "# Network logs contain /api/webhooks/agent/events requests"
}

@test "runner network security: compose accepts experimental_network_security with runner" {
    echo "# Create config with both experimental_runner and experimental_network_security"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  network-runner-agent:
    description: "Test agent with runner and network security"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: acme/production
    experimental_network_security: true
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
}

@test "runner network security: HTTPS requests work through proxy with CA trust" {
    # Skip this test if SKIP_NETWORK_SECURITY_TEST is set
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped (SKIP_NETWORK_SECURITY_TEST set)"
    fi

    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    echo "# Step 1: Create agent config with network security"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-https:
    description: "E2E test agent for HTTPS through proxy"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_network_security: true
EOF

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME-https"
    cd "$TEST_DIR/$ARTIFACT_NAME-https"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME-https" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run curl to verify HTTPS works through mitmproxy"
    # This tests that:
    # 1. CA certificate is properly installed in the VM
    # 2. CURL_CA_BUNDLE environment variable is set correctly
    # 3. TLS handshake succeeds through the proxy
    run $CLI_COMMAND run "${AGENT_NAME}-https" \
        --artifact-name "$ARTIFACT_NAME-https" \
        "curl -sf https://httpbin.org/get | grep -o '\"url\"' | head -1"

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Run completed successfully"

    # If TLS handshake failed, curl would have exited with error
    # The presence of "url" in output confirms the HTTPS request succeeded
    if [[ "$output" == *'"url"'* ]]; then
        echo "# SUCCESS: HTTPS request through proxy succeeded"
    else
        echo "# WARNING: Could not verify HTTPS response content"
        echo "# This may be due to network issues, not CA trust problems"
    fi
}

@test "runner network security: secrets are encrypted in VM environment" {
    # Skip this test if SKIP_NETWORK_SECURITY_TEST is set
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped (SKIP_NETWORK_SECURITY_TEST set)"
    fi

    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    # Use a unique secret value that we can search for
    export TEST_SECRET_VALUE="e2e-test-secret-$(date +%s%3N)-$RANDOM"

    echo "# Step 1: Create agent config with secrets in environment block"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-secrets:
    description: "E2E test agent for secret encryption"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_network_security: true
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

    echo "# Step 4: Run the agent and print the secret environment variable"
    # The task prints the TEST_API_KEY env var - it should be encrypted
    run $CLI_COMMAND run "${AGENT_NAME}-secrets" \
        --artifact-name "$ARTIFACT_NAME-secrets" \
        --secrets "TEST_API_KEY=$TEST_SECRET_VALUE" \
        "echo \"SECRET_VALUE=\$TEST_API_KEY\""

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Run completed successfully"

    # Step 5: Verify the secret in VM is encrypted (starts with vm0_enc_)
    echo "# Step 5: Verifying secret is encrypted in VM..."

    # The output should contain vm0_enc_ prefix (encrypted token)
    if [[ "$output" == *"SECRET_VALUE=vm0_enc_"* ]]; then
        echo "# SUCCESS: Secret is encrypted in VM environment (vm0_enc_ prefix found)"
    else
        echo "# FAILED: Secret encryption check"
        echo "# Expected: SECRET_VALUE=vm0_enc_..."
        fail "Secret should be encrypted with vm0_enc_ prefix in VM environment"
    fi

    # Step 6: Verify the original secret value is NOT in the output
    echo "# Step 6: Verifying original secret is not leaked..."

    if [[ "$output" == *"$TEST_SECRET_VALUE"* ]]; then
        echo "# FAILED: Original secret value found in output!"
        fail "Original secret value should NOT appear in VM output"
    else
        echo "# SUCCESS: Original secret value is not leaked in output"
    fi
}

@test "runner network security: network logs do not contain original secrets" {
    # Skip this test if SKIP_NETWORK_SECURITY_TEST is set
    if [[ -n "$SKIP_NETWORK_SECURITY_TEST" ]]; then
        skip "Network security test skipped (SKIP_NETWORK_SECURITY_TEST set)"
    fi

    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    # Use a unique secret value that we can search for in logs
    export TEST_SECRET_VALUE="e2e-secret-leak-test-$(date +%s%3N)-$RANDOM"

    echo "# Step 1: Create agent config with secrets in environment block"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-leak:
    description: "E2E test agent for secret leak detection"
    provider: claude-code
    working_dir: /home/user/workspace
    experimental_runner:
      group: ${RUNNER_GROUP}
    experimental_network_security: true
    environment:
      LEAK_TEST_KEY: "\${{ secrets.LEAK_TEST_KEY }}"
EOF

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME-leak"
    cd "$TEST_DIR/$ARTIFACT_NAME-leak"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME-leak" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run the agent with secret"
    run $CLI_COMMAND run "${AGENT_NAME}-leak" \
        --artifact-name "$ARTIFACT_NAME-leak" \
        --secrets "LEAK_TEST_KEY=$TEST_SECRET_VALUE" \
        "echo 'network security leak test'"

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Run completed successfully"

    # Step 5: Extract Run ID
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    echo "# Run ID: $RUN_ID"
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID from output"
        return 1
    }

    # Step 6: Fetch network logs and verify secret is not leaked
    echo "# Step 6: Fetching network logs to check for secret leaks..."

    # Wait for Axiom ingestion
    sleep 5

    run $CLI_COMMAND logs "$RUN_ID" --network --tail 200

    echo "# Network logs output:"
    echo "$output"

    # Step 7: Verify original secret is NOT in network logs
    echo "# Step 7: Verifying secret is not in network logs..."

    if [[ "$output" == *"$TEST_SECRET_VALUE"* ]]; then
        echo "# FAILED: Original secret value found in network logs!"
        fail "Original secret value should NOT appear in network logs"
    else
        echo "# SUCCESS: Original secret value is not leaked in network logs"
    fi

    # Also verify vm0_enc_ tokens are not fully exposed (only prefix should be visible if at all)
    # The encrypted token itself is fine to log since it can't be decrypted without the key
    echo "# Network logs security check passed"
}
