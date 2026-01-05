#!/usr/bin/env bats

# Test Runner telemetry collection and retrieval
# The runner is started by the CI workflow before these tests run.
#
# This test verifies that:
# 1. Agent runs display Run ID at start
# 2. Agent runs collect telemetry data (system log and metrics)
# 3. The vm0 logs command can retrieve telemetry data

load '../../helpers/setup.bash'
load '../../helpers/ssh.bash'
load '../../helpers/runner.bash'

# Unique agent name for this test file
AGENT_NAME="e2e-runner-t07"

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

    if [[ -z "$RUNNER_GROUP" ]]; then
        skip "RUNNER_GROUP not set - runner was not started by workflow"
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
      group: ${RUNNER_GROUP}
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
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
    if [ -n "$TEST_CONFIG" ] && [ -f "$TEST_CONFIG" ]; then
        rm -f "$TEST_CONFIG"
    fi
}

@test "Runner telemetry: compose agent with experimental_runner" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "Runner telemetry: run displays Run ID and logs command retrieves data" {
    echo "# Using shared runner with group: ${RUNNER_GROUP}"

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
    run $CLI_COMMAND run "$AGENT_NAME" \
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
}
