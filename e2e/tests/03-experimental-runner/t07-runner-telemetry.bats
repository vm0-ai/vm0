#!/usr/bin/env bats

# Test Runner telemetry collection and retrieval
# Adapted from 02-parallel/t15-vm0-telemetry.bats for runner execution
#
# This test verifies that:
# 1. Agent runs display Run ID at start
# 2. Agent runs collect telemetry data (system log and metrics)
# 3. The vm0 logs command can retrieve telemetry data

load '../../helpers/setup.bash'
load '../../helpers/ssh.bash'

# Unique agent name for this test file
AGENT_NAME="e2e-runner-t07"

# Test-specific setup
TEST_RUNNER_GROUP="e2e/telemetry-test-$$"
RUNNER_PID_FILE="/tmp/vm0-runner-telemetry-$$.pid"

# Setup runner config on AWS Metal
setup_runner_config() {
    local token="$1"
    local api_url="$2"

    ssh_run "cat > ${RUNNER_DIR}/runner.yaml << EOFCONFIG
name: e2e-telemetry-runner
group: ${TEST_RUNNER_GROUP}
server:
  url: ${api_url}
  token: ${token}
sandbox:
  max_concurrent: 1
  vcpu: 2
  memory_mb: 512
firecracker:
  binary: /usr/local/bin/firecracker
  kernel: /opt/firecracker/vmlinux
  rootfs: /opt/firecracker/rootfs.ext4
EOFCONFIG"
}

# Start runner in background
start_runner() {
    local env_exports=""
    if [ -n "$VERCEL_AUTOMATION_BYPASS_SECRET" ]; then
        env_exports="export VERCEL_AUTOMATION_BYPASS_SECRET='${VERCEL_AUTOMATION_BYPASS_SECRET}' && "
    fi
    if [ -n "$USE_MOCK_CLAUDE" ]; then
        env_exports="${env_exports}export USE_MOCK_CLAUDE='${USE_MOCK_CLAUDE}' && "
    fi

    ssh_run "cd ${RUNNER_DIR} && ${env_exports}nohup node index.js start > /tmp/vm0-runner-telemetry.log 2>&1 & echo \$! > ${RUNNER_PID_FILE}"
    sleep 3

    local pid=$(ssh_run "cat ${RUNNER_PID_FILE} 2>/dev/null || echo ''")
    if [ -z "$pid" ]; then
        echo "Failed to start runner"
        return 1
    fi
    echo "Runner started with PID: $pid"
}

# Stop runner
stop_runner() {
    local pid=$(ssh_run "cat ${RUNNER_PID_FILE} 2>/dev/null || echo ''")
    if [ -n "$pid" ]; then
        ssh_run "kill $pid 2>/dev/null || true"
        ssh_run "rm -f ${RUNNER_PID_FILE}"
    fi
}

# Get runner logs
get_runner_logs() {
    ssh_run "cat /tmp/vm0-runner-telemetry.log 2>/dev/null || echo 'No logs'"
}

setup() {
    # Verify prerequisites
    if [[ -z "$RUNNER_DIR" ]]; then
        skip "RUNNER_DIR not set - runner was not deployed"
    fi

    if ! ssh_check; then
        skip "Remote instance not reachable"
    fi

    if [[ -z "$VM0_API_URL" ]]; then
        skip "VM0_API_URL not set"
    fi

    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-runner-telemetry-${UNIQUE_ID}"

    # Create inline config with runner
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for telemetry testing with runner"
    provider: claude-code
    experimental_runner:
      group: ${TEST_RUNNER_GROUP}
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: claude-files
    version: latest
EOF
}

teardown() {
    stop_runner

    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
    if [ -n "$TEST_CONFIG" ] && [ -f "$TEST_CONFIG" ]; then
        rm -f "$TEST_CONFIG"
    fi
    ssh_run "rm -f ${RUNNER_DIR}/runner.yaml" 2>/dev/null || true
}

# Helper to setup runner
setup_and_start_runner() {
    local cli_config_file="$HOME/.vm0/config.json"
    [ -f "$cli_config_file" ] || skip "CLI config not found"

    local token=$(cat "$cli_config_file" | grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/"token"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/')
    [ -n "$token" ] || skip "No token found"

    setup_runner_config "$token" "$VM0_API_URL"
    run start_runner
    assert_success
    sleep 5
}

@test "Runner telemetry: compose agent with experimental_runner" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "Runner telemetry: run displays Run ID and logs command retrieves data" {
    setup_and_start_runner

    # Compose the agent
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test content" > test.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent
    echo "# Step 2: Running agent..."
    run timeout 120s $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'hello from agent'"

    echo "# Output:"
    echo "$output"

    assert_success

    # Verify "Run started" message with Run ID
    assert_output --partial "Run started"
    assert_output --partial "Run ID:"

    # Verify run completed
    assert_output --partial "Run completed successfully"

    # Verify logs hint
    assert_output --partial "View agent logs:"
    assert_output --partial "vm0 logs"

    # Step 3: Extract Run ID
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    echo "# Run ID: $RUN_ID"
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        get_runner_logs
        return 1
    }

    # Step 4: Verify vm0 logs (default: agent events)
    echo "# Step 4: Fetching agent events..."
    run $CLI_COMMAND logs "$RUN_ID"

    assert_success
    assert_output --partial "[init]"
    assert_output --partial "[result]"
    echo "# Agent events OK"

    # Step 5: Verify --agent option
    echo "# Step 5: Testing --agent option..."
    run $CLI_COMMAND logs "$RUN_ID" --agent

    assert_success
    assert_output --partial "[init]"
    echo "# --agent option OK"

    # Step 6: Verify --system option
    echo "# Step 6: Testing --system option..."
    run $CLI_COMMAND logs "$RUN_ID" --system --tail 100

    assert_success
    assert_output --partial "[INFO]"
    assert_output --partial "[sandbox:"
    echo "# System log OK"

    # Step 7: Verify --metrics option
    echo "# Step 7: Testing --metrics option..."
    run $CLI_COMMAND logs "$RUN_ID" --metrics --tail 100

    assert_success
    assert_output --partial "CPU:"
    assert_output --partial "Mem:"
    assert_output --partial "Disk:"
    echo "# Metrics OK"

    # Step 8: Verify --tail option
    echo "# Step 8: Testing --tail option..."
    run $CLI_COMMAND logs "$RUN_ID" --tail 2

    assert_success
    echo "# Tail option OK"

    # Step 9: Verify mutually exclusive options
    echo "# Step 9: Testing mutually exclusive options..."
    run $CLI_COMMAND logs "$RUN_ID" --agent --system

    assert_failure
    assert_output --partial "mutually exclusive"
    echo "# Mutually exclusive OK"

    echo "# Runner logs:"
    get_runner_logs
}
