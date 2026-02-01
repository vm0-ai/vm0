#!/usr/bin/env bats

# Test VM0 compose with scope support (E2E happy path only)
# Tests the scope/name:version naming convention for agent composes
#
# This test covers issue #757: Add scope support to agent compose
#
# Note: Identifier format parsing and error handling (scope/name, scope/name:version, name:version,
# backward compat, scope errors) are tested via CLI Command Integration Tests
# (see run/__tests__/index.test.ts, "scope error handling" section).

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    # Use UUID for reliable uniqueness in parallel test runs
    export AGENT_NAME="e2e-scope-compose-$(cat /proc/sys/kernel/random/uuid | head -c 8)"
    export ARTIFACT_NAME="e2e-scope-artifact-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # Clean up temporary directory
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

# ============================================
# vm0 compose displays scope/name format
# ============================================

@test "t22-1: vm0 compose shows scope/name:version in run instructions" {
    echo "# Creating config file..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for run instructions"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Running vm0 compose..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Verifying output contains scope/name format..."
    # Output should show something like "Compose created: user-abc12345/e2e-scope-compose-xxxx"
    assert_output --regexp "Compose (created|version exists): [a-z0-9-]+/$AGENT_NAME"

    echo "# Verifying output contains version..."
    assert_output --partial "Version:"
    assert_output --regexp "Version:[ ]+[0-9a-f]{8}"

    echo "# Verifying run instructions include scope/name:version format..."
    # Output should show: vm0 run scope/name:version
    assert_output --regexp "vm0 run [a-z0-9-]+/$AGENT_NAME:[0-9a-f]{8}"
}

# ============================================
# vm0 run with scope/name format (E2E happy path)
# ============================================

@test "t22-2: vm0 run with scope/name format resolves agent correctly" {
    # This test verifies the end-to-end happy path for scope/name format.
    # Other identifier formats (scope/name:version, name:version, backward compat)
    # are tested via CLI Command Integration Tests in run/__tests__/index.test.ts.

    echo "# Step 1: Creating agent config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for scope/name run"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Composing agent..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Extract scope from compose output (format: "Compose created: scope/agent-name")
    # This ensures we use the same scope that compose actually used, avoiding race conditions
    USER_SCOPE=$(echo "$output" | grep -oP '(created|exists): \K[a-z0-9-]+(?=/)' | head -1)
    echo "# Scope from compose output: $USER_SCOPE"

    [ -n "$USER_SCOPE" ] || {
        echo "# Failed to extract scope from compose output"
        echo "# Output was: $output"
        return 1
    }

    echo "# Step 3: Setting up artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Step 4: Running with scope/name format..."
    run $CLI_COMMAND run "$USER_SCOPE/$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello from scope test"
    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "hello from scope test"
}
