#!/usr/bin/env bats

# E2E tests for experimental_runner compose field with actual runner execution
# The runner is started by the CI workflow before these tests run.
# Tests submit jobs and verify the shared runner picks them up.
#
# These are BLACK BOX tests - they only interact via the CLI/API,
# not by SSH-ing into the runner machine.

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
    export AGENT_NAME="e2e-runner-test-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-runner-artifact-${UNIQUE_ID}"
}

teardown() {
    # Clean up test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# ============================================
# Full E2E test with runner execution
# ============================================

@test "experimental_runner: full e2e flow with runner execution" {
    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    echo "# Step 1: Create agent config with experimental_runner"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "E2E test agent for experimental runner"
    framework: claude-code
    experimental_runner:
      group: ${RUNNER_GROUP}
EOF

    echo "# Step 2: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test content for e2e" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    echo "# Step 3: Compose the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run the agent (runner should pick it up)"
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello from experimental runner"

    echo "# Run output:"
    echo "$output"

    # Verify the run completed successfully
    assert_success

    # Verify the run completed with expected output
    assert_output --partial "Run completed successfully"
}

@test "experimental_runner: compose validation accepts valid group format" {
    echo "# Create config with valid experimental_runner"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  valid-runner-agent:
    description: "Test agent with valid runner group"
    framework: claude-code
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
    framework: claude-code
    experimental_runner:
      group: invalid-no-slash
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    assert_output --partial "scope/name format"
}
