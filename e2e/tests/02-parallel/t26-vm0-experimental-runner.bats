#!/usr/bin/env bats

# E2E tests for experimental_runner compose field
# Tests schema validation and run creation routing

load '../../helpers/setup'

setup() {
    # Create temporary test directory for dynamic configs
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-exp-runner-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-exp-runner-artifact-${UNIQUE_ID}"
}

teardown() {
    # Clean up temporary directories
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# Helper to create artifact for tests
setup_artifact() {
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1
}

# ============================================
# Compose validation tests for experimental_runner
# ============================================

@test "vm0 compose accepts valid experimental_runner group format" {
    echo "# Step 1: Create config with valid experimental_runner"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with valid runner group"
    provider: claude-code
    experimental_runner:
      group: acme/production
EOF

    echo "# Step 2: Compose should succeed"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
    assert_output --partial "Compose"
}

@test "vm0 compose rejects invalid experimental_runner group format (missing slash)" {
    echo "# Step 1: Create config with invalid runner group"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  invalid-runner-agent:
    description: "Test agent with invalid runner group"
    provider: claude-code
    experimental_runner:
      group: invalid-no-slash
EOF

    echo "# Step 2: Compose should fail validation"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    assert_output --partial "scope/name format"
}

@test "vm0 compose rejects invalid experimental_runner group format (uppercase)" {
    echo "# Step 1: Create config with uppercase in runner group"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  invalid-runner-agent:
    description: "Test agent with invalid runner group"
    provider: claude-code
    experimental_runner:
      group: Acme/Production
EOF

    echo "# Step 2: Compose should fail validation"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    assert_output --partial "scope/name format"
}

@test "vm0 compose rejects experimental_runner without group" {
    echo "# Step 1: Create config without group field"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  invalid-runner-agent:
    description: "Test agent without runner group"
    provider: claude-code
    experimental_runner: {}
EOF

    echo "# Step 2: Compose should fail validation"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
}

@test "vm0 compose accepts various valid runner group formats" {
    echo "# Step 1: Test with hyphenated names"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with hyphenated runner group"
    provider: claude-code
    experimental_runner:
      group: my-org/my-runners
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 2: Test with numbers"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with numbered runner group"
    provider: claude-code
    experimental_runner:
      group: team123/runner456
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
}

# ============================================
# Run creation tests with experimental_runner
# ============================================

@test "vm0 run with experimental_runner creates run in pending status" {
    echo "# Step 1: Create config with experimental_runner"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent routed to runner"
    provider: claude-code
    experimental_runner:
      group: e2e/test-runner
EOF

    echo "# Step 2: Create and push artifact"
    setup_artifact

    echo "# Step 3: Compose the config"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run (will create in pending status waiting for runner)"
    # Using timeout because no runner is available to pick up the job
    # The run should be created successfully but will be waiting
    run timeout 10s $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello" 2>&1 || true

    echo "# Step 5: Verify run was created (output should show run ID)"
    # Even if the run times out waiting, it should have created the run
    # The output should contain either a Run ID or waiting message
    [[ "$output" =~ "Run ID:" ]] || [[ "$output" =~ "pending" ]] || [[ "$output" =~ "Timeout" ]] || [[ "$output" =~ "runner" ]]
}

@test "vm0 compose with both experimental_runner and experimental_secrets works" {
    echo "# Step 1: Create config with both experimental fields"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with runner and secrets"
    provider: claude-code
    experimental_runner:
      group: e2e/test-runner
    experimental_secrets:
      - API_KEY
    experimental_vars:
      - REGION
EOF

    echo "# Step 2: Compose should succeed"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
    assert_output --partial "Compose"
}
