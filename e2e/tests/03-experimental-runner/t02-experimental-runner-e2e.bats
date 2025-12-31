#!/usr/bin/env bats

# E2E tests for experimental_runner compose field with actual runner execution
# These tests run the full flow:
# 1. Start runner on AWS Metal instance
# 2. Compose agent with experimental_runner
# 3. Run agent and verify runner picks it up and completes

load '../../helpers/setup.bash'
load '../../helpers/ssh.bash'

# Test-specific setup
TEST_RUNNER_GROUP="e2e/test-runner-$$"
RUNNER_PID_FILE="/tmp/vm0-runner-e2e-$$.pid"

# Helper to run vm0-runner commands on remote
runner_cmd() {
    ssh_run "cd ${RUNNER_DIR} && node index.js $*"
}

# Setup runner authentication and config on AWS Metal
setup_runner_auth() {
    local token="$1"
    local api_url="$2"

    # Create ~/.vm0 directory and runner-token.json on remote
    ssh_run "mkdir -p ~/.vm0"
    ssh_run "cat > ~/.vm0/runner-token.json << 'EOFTOKEN'
{
  \"token\": \"${token}\",
  \"apiUrl\": \"${api_url}\"
}
EOFTOKEN"

    # Create runner.yaml config
    ssh_run "cat > ${RUNNER_DIR}/runner.yaml << 'EOFCONFIG'
name: e2e-test-runner
group: ${TEST_RUNNER_GROUP}
sandbox:
  max_concurrent: 1
  vcpu: 2
  memory_mb: 2048
firecracker:
  binary: /usr/local/bin/firecracker
  kernel: /opt/firecracker/vmlinux
  rootfs: /opt/firecracker/rootfs.ext4
EOFCONFIG"
}

# Start runner in background on AWS Metal
start_runner() {
    # Build environment variable exports for runner
    local env_exports=""
    if [ -n "$VERCEL_AUTOMATION_BYPASS_SECRET" ]; then
        env_exports="export VERCEL_AUTOMATION_BYPASS_SECRET='${VERCEL_AUTOMATION_BYPASS_SECRET}' && "
    fi

    # Start runner in background and save PID
    # Use bash -c to properly handle environment variables with nohup
    ssh_run "cd ${RUNNER_DIR} && ${env_exports}nohup node index.js start > /tmp/vm0-runner-e2e.log 2>&1 & echo \$! > ${RUNNER_PID_FILE}"

    # Wait for runner to register
    sleep 3

    # Verify runner started
    local pid=$(ssh_run "cat ${RUNNER_PID_FILE} 2>/dev/null || echo ''")
    if [ -z "$pid" ]; then
        echo "Failed to start runner"
        return 1
    fi

    echo "Runner started with PID: $pid"
}

# Stop runner on AWS Metal
stop_runner() {
    local pid=$(ssh_run "cat ${RUNNER_PID_FILE} 2>/dev/null || echo ''")
    if [ -n "$pid" ]; then
        ssh_run "kill $pid 2>/dev/null || true"
        ssh_run "rm -f ${RUNNER_PID_FILE}"
    fi
}

# Get runner logs from AWS Metal
get_runner_logs() {
    ssh_run "cat /tmp/vm0-runner-e2e.log 2>/dev/null || echo 'No logs'"
}

# Verify test prerequisites
setup() {
    if [[ -z "$RUNNER_DIR" ]]; then
        fail "RUNNER_DIR not set - runner was not deployed"
    fi

    if ! ssh_check; then
        fail "Remote instance not reachable - check CI_AWS_METAL_RUNNER_* secrets"
    fi

    if [[ -z "$VM0_API_URL" ]]; then
        fail "VM0_API_URL not set"
    fi

    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-runner-test-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-runner-artifact-${UNIQUE_ID}"
}

teardown() {
    # Stop runner if running
    stop_runner

    # Clean up test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi

    # Clean up remote config
    ssh_run "rm -f ~/.vm0/runner-token.json ${RUNNER_DIR}/runner.yaml" 2>/dev/null || true
}

# ============================================
# Full E2E test with runner execution
# ============================================

@test "experimental_runner: full e2e flow with runner execution" {
    echo "# Step 1: Get CLI auth token"
    # Read token from CLI config (created by auth automation)
    local cli_config_file="$HOME/.vm0/config.json"
    [ -f "$cli_config_file" ] || fail "CLI config not found at $cli_config_file - auth automation must run first"

    local token=$(cat "$cli_config_file" | grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/"token"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/')
    [ -n "$token" ] || fail "No token found in CLI config"

    echo "# Step 2: Setup runner authentication on AWS Metal"
    setup_runner_auth "$token" "$VM0_API_URL"

    echo "# Step 3: Start runner in background"
    run start_runner
    assert_success

    # Give runner time to register
    sleep 5

    # Check runner logs for registration status
    local runner_logs=$(get_runner_logs)
    echo "# Initial runner logs:"
    echo "$runner_logs"

    # Verify runner registered successfully
    if ! [[ "$runner_logs" =~ "Runner registered" ]]; then
        echo "# Runner registration may have failed"
        # Continue anyway to see the actual error in final logs
    fi

    echo "# Step 4: Create agent config with experimental_runner"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "E2E test agent for experimental runner"
    provider: claude-code
    experimental_runner:
      group: ${TEST_RUNNER_GROUP}
EOF

    echo "# Step 5: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test content for e2e" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 6: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 7: Run the agent (runner should pick it up)"
    # Run with timeout since runner is stub and completes quickly
    run timeout 60s $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello from experimental runner"

    # The run should complete (either success or the runner stub completes it)
    echo "# Run output:"
    echo "$output"

    echo "# Step 8: Get runner logs"
    runner_logs=$(get_runner_logs)
    echo "# Runner logs:"
    echo "$runner_logs"

    echo "# Step 9: Verify runner processed the job"
    # Check if runner claimed and executed the job
    [[ "$runner_logs" =~ "Found job" ]] || [[ "$runner_logs" =~ "Claimed job" ]] || [[ "$runner_logs" =~ "reported as completed" ]]
}

@test "experimental_runner: compose validation accepts valid group format" {
    echo "# Create config with valid experimental_runner"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  valid-runner-agent:
    description: "Test agent with valid runner group"
    provider: claude-code
    experimental_runner:
      group: acme/production
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
}

@test "experimental_runner: compose validation rejects invalid group format" {
    echo "# Create config with invalid runner group (missing slash)"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  invalid-runner-agent:
    description: "Test agent with invalid runner group"
    provider: claude-code
    experimental_runner:
      group: invalid-no-slash
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    assert_output --partial "scope/name format"
}
