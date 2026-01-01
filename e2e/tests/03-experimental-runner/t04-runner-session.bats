#!/usr/bin/env bats

# Test Runner agent session and continue functionality
# Adapted from 02-parallel/t06-vm0-agent-session.bats for runner execution
#
# This test verifies that:
# 1. Agent runs create agent sessions
# 2. vm0 run continue uses session's conversation but latest artifact version
# 3. Session stores and inherits templateVars for continue operations

load '../../helpers/setup.bash'
load '../../helpers/ssh.bash'

# Unique agent name for this test file
AGENT_NAME="e2e-runner-t04"

# Test-specific setup
TEST_RUNNER_GROUP="e2e/session-test-$$"
RUNNER_PID_FILE="/tmp/vm0-runner-session-$$.pid"

# Setup runner config on AWS Metal
setup_runner_config() {
    local token="$1"
    local api_url="$2"

    ssh_run "cat > ${RUNNER_DIR}/runner.yaml << EOFCONFIG
name: e2e-session-runner
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

# Start runner in background on AWS Metal
start_runner() {
    local env_exports=""
    if [ -n "$VERCEL_AUTOMATION_BYPASS_SECRET" ]; then
        env_exports="export VERCEL_AUTOMATION_BYPASS_SECRET='${VERCEL_AUTOMATION_BYPASS_SECRET}' && "
    fi
    if [ -n "$USE_MOCK_CLAUDE" ]; then
        env_exports="${env_exports}export USE_MOCK_CLAUDE='${USE_MOCK_CLAUDE}' && "
    fi

    ssh_run "cd ${RUNNER_DIR} && ${env_exports}nohup node index.js start > /tmp/vm0-runner-session.log 2>&1 & echo \$! > ${RUNNER_PID_FILE}"
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
    ssh_run "cat /tmp/vm0-runner-session.log 2>/dev/null || echo 'No logs'"
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
    export ARTIFACT_NAME="e2e-runner-session-art-${UNIQUE_ID}"

    # Create inline config with runner
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for session testing with runner"
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

# Helper to setup runner once per test
setup_and_start_runner() {
    local cli_config_file="$HOME/.vm0/config.json"
    [ -f "$cli_config_file" ] || skip "CLI config not found - auth automation must run first"

    local token=$(cat "$cli_config_file" | grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/"token"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/')
    [ -n "$token" ] || skip "No token found in CLI config"

    setup_runner_config "$token" "$VM0_API_URL"
    run start_runner
    assert_success
    sleep 5
}

@test "Runner session: compose agent with experimental_runner" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "Runner session: continue uses latest artifact version" {
    setup_and_start_runner

    # Compose the agent
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # Step 1: Create artifact with initial content
    echo "# Step 1: Creating initial artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "initial" > marker.txt
    echo "100" > counter.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent to modify artifact
    echo "# Step 2: Running agent to create session..."
    run timeout 120s $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'agent-created' > agent.txt && echo 200 > counter.txt"

    echo "# Run output:"
    echo "$output"

    assert_success
    assert_output --partial "Checkpoint:"
    assert_output --partial "Session:"

    # Extract session ID
    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ] || {
        echo "# Failed to extract session ID"
        get_runner_logs
        return 1
    }

    # Step 3: Push NEW content to artifact
    echo "# Step 3: Pushing new content to make HEAD different..."
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    echo "external-update" > external.txt
    echo "999" > counter.txt
    rm -f agent.txt 2>/dev/null || true

    run $CLI_COMMAND artifact push
    assert_success

    # Step 4: Continue from session - should get LATEST artifact (HEAD)
    echo "# Step 4: Continuing from session..."
    run timeout 120s $CLI_COMMAND run continue "$SESSION_ID" "ls && cat counter.txt"

    echo "# Continue output:"
    echo "$output"

    assert_success

    # Step 5: Verify LATEST version is used
    echo "# Step 5: Verifying latest artifact version..."

    # Should see external.txt (added after checkpoint)
    assert_output --partial "external.txt"

    # Should NOT see agent.txt (removed in step 3)
    refute_output --partial "agent.txt"

    # Counter should be 999 (from HEAD), not 200 (from checkpoint)
    assert_output --partial "999"

    echo "# Runner logs:"
    get_runner_logs
}

@test "Runner session: session persists across runs with same config" {
    setup_and_start_runner

    # Compose the agent
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "test" > file.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: First run
    echo "# Step 2: First run..."
    run timeout 120s $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'first run'"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID_1=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# First session ID: $SESSION_ID_1"
    [ -n "$SESSION_ID_1" ]

    # Step 3: Second run
    echo "# Step 3: Second run..."
    run timeout 120s $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'second run'"

    assert_success
    assert_output --partial "Session:"

    SESSION_ID_2=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Second session ID: $SESSION_ID_2"
    [ -n "$SESSION_ID_2" ]

    # Session IDs should be the same
    [ "$SESSION_ID_1" = "$SESSION_ID_2" ] || {
        echo "# Session IDs don't match!"
        echo "# First:  $SESSION_ID_1"
        echo "# Second: $SESSION_ID_2"
        get_runner_logs
        return 1
    }

    echo "# Verified: Same session returned"
    get_runner_logs
}

@test "Runner session: continue works with templateVars" {
    setup_and_start_runner

    # Compose the agent
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "initial-content" > testfile.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent WITH template variables
    echo "# Step 2: Running agent with --vars..."
    run timeout 120s $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testKey=testValue" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'initial run' && cat testfile.txt"

    assert_success
    assert_output --partial "initial-content"
    assert_output --partial "Session:"

    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $SESSION_ID"
    [ -n "$SESSION_ID" ]

    # Step 3: Update artifact
    echo "# Step 3: Updating artifact..."
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    echo "updated-content" > testfile.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 4: Continue from session
    echo "# Step 4: Continuing from session..."
    run timeout 120s $CLI_COMMAND run continue "$SESSION_ID" "cat testfile.txt"

    assert_success

    # Should see updated content
    assert_output --partial "updated-content"

    echo "# Verified: Continue works with templateVars"
    get_runner_logs
}
