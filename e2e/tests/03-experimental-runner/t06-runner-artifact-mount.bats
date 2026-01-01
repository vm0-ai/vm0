#!/usr/bin/env bats

# Test Runner artifact mounting to sandbox
# Adapted from 02-parallel/t05-vm0-artifact-mount.bats for runner execution
#
# Verifies that artifacts pushed via CLI are correctly mounted and visible
# in the sandbox during agent runs with runner

load '../../helpers/setup.bash'
load '../../helpers/ssh.bash'

# Unique agent name for this test file
AGENT_NAME="e2e-runner-t06"

# Test-specific setup
TEST_RUNNER_GROUP="e2e/mount-test-$$"
RUNNER_PID_FILE="/tmp/vm0-runner-mount-$$.pid"

# Setup runner config on AWS Metal
setup_runner_config() {
    local token="$1"
    local api_url="$2"

    ssh_run "cat > ${RUNNER_DIR}/runner.yaml << EOFCONFIG
name: e2e-mount-runner
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

# Start runner in background
start_runner() {
    local env_exports=""
    if [ -n "$VERCEL_AUTOMATION_BYPASS_SECRET" ]; then
        env_exports="export VERCEL_AUTOMATION_BYPASS_SECRET='${VERCEL_AUTOMATION_BYPASS_SECRET}' && "
    fi
    if [ -n "$USE_MOCK_CLAUDE" ]; then
        env_exports="${env_exports}export USE_MOCK_CLAUDE='${USE_MOCK_CLAUDE}' && "
    fi

    ssh_run "cd ${RUNNER_DIR} && ${env_exports}nohup node index.js start > /tmp/vm0-runner-mount.log 2>&1 & echo \$! > ${RUNNER_PID_FILE}"
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
    ssh_run "cat /tmp/vm0-runner-mount.log 2>/dev/null || echo 'No logs'"
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
    export ARTIFACT_NAME="e2e-runner-mount-${UNIQUE_ID}"

    # Create inline config with runner
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for artifact mount testing with runner"
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

@test "Runner mount: compose agent with experimental_runner" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "Runner mount: artifact files are visible in sandbox working directory" {
    setup_and_start_runner

    # Compose the agent
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # Step 1: Create artifact with known content
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "hello from artifact" > test-file.txt
    mkdir -p subdir
    echo "nested content" > subdir/nested.txt

    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent with artifact, list files
    echo "# Step 2: Running agent to list files..."
    run timeout 120s $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "ls -la && cat test-file.txt && cat subdir/nested.txt"

    echo "# Output:"
    echo "$output"

    assert_success

    # Step 3: Verify files are visible
    echo "# Step 3: Verifying files..."
    assert_output --partial "test-file.txt"
    assert_output --partial "subdir"
    assert_output --partial "hello from artifact"
    assert_output --partial "nested content"

    # Step 4: Verify run completes properly
    assert_output --partial "Checkpoint:"

    echo "# Runner logs:"
    get_runner_logs
}

@test "Runner mount: run completes with checkpoint" {
    setup_and_start_runner

    # Compose the agent
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    # Create artifact
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > data.txt
    $CLI_COMMAND artifact push >/dev/null

    # Simple run that should complete
    echo "# Running simple command..."
    run timeout 120s $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo done"

    echo "# Output:"
    echo "$output"

    assert_success
    assert_output --partial "Run completed successfully"

    echo "# Runner logs:"
    get_runner_logs
}
