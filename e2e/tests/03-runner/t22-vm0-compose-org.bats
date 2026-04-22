#!/usr/bin/env bats

# Test VM0 compose (E2E happy path only)
# Tests the name:version naming convention for agent composes
#
# Note: Identifier format parsing and error handling (name:version,
# backward compat) are tested via CLI Command Integration Tests
# (see run/__tests__/index.test.ts).

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    # Use UUID for reliable uniqueness in parallel test runs
    export AGENT_NAME="e2e-org-compose-$(cat /proc/sys/kernel/random/uuid | head -c 8)"
    export ARTIFACT_NAME="e2e-org-artifact-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # Clean up temporary directory
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

# ============================================
# vm0 compose displays org/name format
# ============================================

@test "t22-1: vm0 compose shows name:version in run instructions" {
    echo "# Creating config file..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for run instructions"
    framework: claude-code
    working_dir: /home/user/workspace
EOF

    echo "# Running vm0 compose..."
    run $VM0_CLI compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Verifying output contains agent name..."
    # Output should show something like "Compose created: e2e-org-compose-xxxx"
    assert_output --regexp "Compose (created|version exists): $AGENT_NAME"

    echo "# Verifying output contains version..."
    assert_output --partial "Version:"
    assert_output --regexp "Version:[ ]+[0-9a-f]{8}"

    echo "# Verifying run instructions include name:version format..."
    # Output should show: vm0 run name:version
    assert_output --regexp "vm0 run $AGENT_NAME:[0-9a-f]{8}"
}

# ============================================
# vm0 run with org/name format (E2E happy path)
# ============================================

@test "t22-2: vm0 run with name format resolves agent correctly" {
    echo "# Step 1: Creating agent config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for name run"
    framework: claude-code
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Composing agent..."
    run $VM0_CLI compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Setting up artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $VM0_CLI artifact push
    assert_success

    echo "# Step 4: Running with name format..."
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo hello from name test"
    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "hello from name test"
}

# ============================================
# vm0 compose default file behavior
# ============================================

@test "t22-3: vm0 compose uses vm0.yaml by default when no argument provided" {
    # This test verifies that running `vm0 compose` without arguments
    # defaults to using vm0.yaml in the current directory (issue #2286)

    echo "# Creating vm0.yaml in test directory..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for default file behavior"
    framework: claude-code
    working_dir: /home/user/workspace
EOF

    echo "# Running vm0 compose without arguments from test directory..."
    cd "$TEST_DIR"
    run $VM0_CLI compose
    cd - >/dev/null

    assert_success

    echo "# Verifying compose succeeded with default vm0.yaml..."
    assert_output --regexp "Compose (created|version exists): $AGENT_NAME"
    assert_output --partial "Version:"
}
