#!/usr/bin/env bats

# Test VM0 compose with scope support
# Tests the scope/name:version naming convention for agent composes
#
# This test covers issue #757: Add scope support to agent compose
#
# Note: Error handling tests (non-existent scope/agent/version, cross-scope isolation)
# have been moved to unit tests at turbo/apps/cli/src/__tests__/compose-scope.test.ts
# for faster feedback and better test performance.

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

@test "vm0 compose shows scope/name:version in run instructions" {
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
# vm0 run with scope/name format
# ============================================

@test "vm0 run with scope/name format resolves agent correctly" {
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
}

@test "vm0 run with scope/name:version format works correctly" {
    echo "# Step 1: Creating agent config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for scope/name:version run"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Composing agent..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Extract scope from compose output (avoids race condition with parallel tests)
    USER_SCOPE=$(echo "$output" | grep -oP '(created|exists): \K[a-z0-9-]+(?=/)' | head -1)
    echo "# Scope from compose output: $USER_SCOPE"

    # Extract version ID from compose output
    VERSION_ID=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')
    echo "# Version ID: $VERSION_ID"

    [ -n "$USER_SCOPE" ] || {
        echo "# Failed to extract scope from compose output"
        echo "# Output was: $output"
        return 1
    }

    [ -n "$VERSION_ID" ] || {
        echo "# Failed to extract version ID from output:"
        echo "$output"
        return 1
    }

    echo "# Step 3: Setting up artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Step 4: Running with scope/name:version format..."
    run $CLI_COMMAND run "$USER_SCOPE/$AGENT_NAME:$VERSION_ID" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello from versioned scope test"
    assert_success
}

# ============================================
# Backward compatibility tests
# ============================================

@test "vm0 run without scope prefix still works (backward compatible)" {
    echo "# Step 1: Creating agent config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for backward compatibility"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Composing agent..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Setting up artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Step 4: Running without scope prefix (should use user's default scope)..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello from backward compat test"
    assert_success
}

@test "vm0 run with name:version (no scope) still works" {
    echo "# Step 1: Creating agent config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for name:version format"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Composing agent..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Extract version ID
    VERSION_ID=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')
    echo "# Version ID: $VERSION_ID"
    [ -n "$VERSION_ID" ] || {
        echo "# Failed to extract version ID"
        return 1
    }

    echo "# Step 3: Setting up artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Step 4: Running with name:version format (no scope prefix)..."
    run $CLI_COMMAND run "$AGENT_NAME:$VERSION_ID" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello from name:version test"
    assert_success
}
