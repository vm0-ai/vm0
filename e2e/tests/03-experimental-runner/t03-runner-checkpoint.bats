#!/usr/bin/env bats

# Test Runner artifact checkpoint versioning
# Adapted from 02-parallel/t04-vm0-artifact-checkpoint.bats for runner execution
#
# This test verifies that:
# 1. Agent runs create new artifact versions during checkpoint
# 2. Resume from checkpoint restores the specific version from checkpoint, not HEAD

load '../../helpers/setup.bash'
load '../../helpers/ssh.bash'

# Unique agent name for this test file
AGENT_NAME="e2e-runner-t03"

# Test-specific setup
TEST_RUNNER_GROUP="e2e/checkpoint-test-$$"
RUNNER_PID_FILE="/tmp/vm0-runner-checkpoint-$$.pid"

# Helper to run vm0-runner commands on remote
runner_cmd() {
    ssh_run "cd ${RUNNER_DIR} && node index.js $*"
}

# Setup runner config on AWS Metal
setup_runner_config() {
    local token="$1"
    local api_url="$2"

    ssh_run "cat > ${RUNNER_DIR}/runner.yaml << EOFCONFIG
name: e2e-checkpoint-runner
group: ${TEST_RUNNER_GROUP}
server:
  url: ${api_url}
  token: ${token}
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
    local env_exports=""
    if [ -n "$VERCEL_AUTOMATION_BYPASS_SECRET" ]; then
        env_exports="export VERCEL_AUTOMATION_BYPASS_SECRET='${VERCEL_AUTOMATION_BYPASS_SECRET}' && "
    fi

    ssh_run "cd ${RUNNER_DIR} && ${env_exports}nohup node index.js start > /tmp/vm0-runner-checkpoint.log 2>&1 & echo \$! > ${RUNNER_PID_FILE}"
    sleep 3

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

# Get runner logs
get_runner_logs() {
    ssh_run "cat /tmp/vm0-runner-checkpoint.log 2>/dev/null || echo 'No logs'"
}

setup() {
    # Verify prerequisites
    if [[ -z "$RUNNER_DIR" ]]; then
        skip "RUNNER_DIR not set - runner was not deployed"
    fi

    if ! ssh_check; then
        skip "Remote instance not reachable - check CI_AWS_METAL_RUNNER_* secrets"
    fi

    if [[ -z "$VM0_API_URL" ]]; then
        skip "VM0_API_URL not set"
    fi

    # Create temporary test directory
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-runner-checkpoint-art-${UNIQUE_ID}"

    # Create inline config with runner
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for checkpoint testing with runner"
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
    # Stop runner
    stop_runner

    # Clean up temporary directory
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
    # Clean up config file
    if [ -n "$TEST_CONFIG" ] && [ -f "$TEST_CONFIG" ]; then
        rm -f "$TEST_CONFIG"
    fi
    # Clean up remote config
    ssh_run "rm -f ${RUNNER_DIR}/runner.yaml" 2>/dev/null || true
}

@test "Runner checkpoint: compose agent with experimental_runner" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "Runner checkpoint: agent changes preserved on resume, not HEAD" {
    # Get CLI auth token
    local cli_config_file="$HOME/.vm0/config.json"
    [ -f "$cli_config_file" ] || skip "CLI config not found - auth automation must run first"

    local token=$(cat "$cli_config_file" | grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/"token"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/')
    [ -n "$token" ] || skip "No token found in CLI config"

    # Setup and start runner
    echo "# Step 0: Starting runner..."
    setup_runner_config "$token" "$VM0_API_URL"
    run start_runner
    assert_success
    sleep 5

    # Compose the agent
    echo "# Step 0.5: Composing agent..."
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # Step 1: Create artifact with initial content
    echo "# Step 1: Creating initial artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "100" > counter.txt
    echo "initial content" > state.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent to modify artifact
    echo "# Step 2: Running agent to modify artifact..."
    run timeout 120s $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'created by agent' > agent-marker.txt && echo 101 > counter.txt"

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Checkpoint:"

    # Extract checkpoint ID
    CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Checkpoint ID: $CHECKPOINT_ID"
    [ -n "$CHECKPOINT_ID" ] || {
        echo "# Failed to extract checkpoint ID"
        echo "# Runner logs:"
        get_runner_logs
        return 1
    }

    # Step 3: Push new content to artifact (simulating external changes)
    echo "# Step 3: Pushing new content to make HEAD different..."
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    echo "0" > counter.txt
    echo "external content" > state.txt
    echo "external marker" > external-marker.txt
    rm -f agent-marker.txt 2>/dev/null || true

    run $CLI_COMMAND artifact push
    assert_success

    # Step 4: Resume from checkpoint
    echo "# Step 4: Resuming from checkpoint..."
    run timeout 120s $CLI_COMMAND run resume "$CHECKPOINT_ID" \
        "ls && cat counter.txt"

    echo "# Resume output:"
    echo "$output"

    assert_success

    # Step 5: Verify checkpoint version is restored
    echo "# Step 5: Verifying checkpoint version..."

    # Should see agent-marker.txt (created during agent run)
    assert_output --partial "agent-marker.txt"

    # Should NOT see external-marker.txt (added after checkpoint)
    refute_output --partial "external-marker.txt"

    # Counter should be 101 (from checkpoint), not 0 (HEAD)
    assert_output --partial "101"

    echo "# Runner logs:"
    get_runner_logs
}
