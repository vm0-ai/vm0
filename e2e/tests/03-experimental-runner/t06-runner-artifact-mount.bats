#!/usr/bin/env bats

# Test Runner artifact mounting to sandbox
# The runner is started by the CI workflow before these tests run.
#
# Verifies that artifacts pushed via CLI are correctly mounted and visible
# in the sandbox during agent runs with runner
#
# BLACK BOX test - only interacts via CLI/API

load '../../helpers/setup.bash'

# Unique agent name for this test file
AGENT_NAME="e2e-runner-t06"

setup() {
    if [[ -z "$VM0_API_URL" ]]; then
        fail "VM0_API_URL not set"
    fi

    if [[ -z "$RUNNER_GROUP" ]]; then
        fail "RUNNER_GROUP not set - runner was not started by workflow"
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

@test "Runner mount: compose agent with experimental_runner" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "Runner mount: artifact files are visible in sandbox working directory" {
    echo "# Using shared runner with group: ${RUNNER_GROUP}"

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
    run $CLI_COMMAND run "$AGENT_NAME" \
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
}

@test "Runner mount: run completes with checkpoint" {
    echo "# Using shared runner with group: ${RUNNER_GROUP}"

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
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo done"

    echo "# Output:"
    echo "$output"

    assert_success
    assert_output --partial "Run completed successfully"
}
