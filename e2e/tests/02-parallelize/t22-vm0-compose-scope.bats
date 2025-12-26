#!/usr/bin/env bats

# Test VM0 compose with scope support
# Tests the scope/name:version naming convention for agent composes
#
# This test covers issue #757: Add scope support to agent compose

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    # Use UUID for reliable uniqueness in parallel test runs
    export AGENT_NAME="e2e-scope-compose-$(cat /proc/sys/kernel/random/uuid | head -c 8)"
    export ARTIFACT_NAME="e2e-scope-artifact-$(date +%s)"
}

teardown() {
    # Clean up temporary directory
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

# ============================================
# vm0 compose displays scope/name format
# ============================================

@test "vm0 compose displays scope/name format in output" {
    echo "# Creating config file..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for scope display"
    provider: claude-code
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
}

@test "vm0 compose shows scope/name:version in run instructions" {
    echo "# Creating config file..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for run instructions"
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Running vm0 compose..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

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
    provider: claude-code
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
    $CLI_COMMAND artifact init >/dev/null
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
    provider: claude-code
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
    $CLI_COMMAND artifact init >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Step 4: Running with scope/name:version format..."
    run $CLI_COMMAND run "$USER_SCOPE/$AGENT_NAME:$VERSION_ID" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello from versioned scope test"
    assert_success
}

@test "vm0 run with scope/name:latest works correctly" {
    echo "# Step 1: Creating agent config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for scope/name:latest"
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Composing agent..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Extract scope from compose output (avoids race condition with parallel tests)
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
    $CLI_COMMAND artifact init >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Step 4: Running with scope/name:latest format..."
    run $CLI_COMMAND run "$USER_SCOPE/$AGENT_NAME:latest" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello from latest scope test"
    assert_success
}

# ============================================
# Error handling tests
# ============================================

@test "vm0 run with non-existent scope shows error" {
    echo "# Trying to run with a non-existent scope..."
    run $CLI_COMMAND run "nonexistent-scope-xyz123/$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello"

    assert_failure
    # Should show scope not found error
    assert_output --partial "not found"
}

@test "vm0 run with non-existent agent in valid scope shows error" {
    echo "# Step 1: Get user's scope..."
    run $CLI_COMMAND scope status
    if [[ $status -ne 0 ]]; then
        skip "User has no scope configured"
    fi

    USER_SCOPE=$(echo "$output" | grep -oP 'Slug:\s+\K[a-z0-9-]+' | head -1)
    [ -n "$USER_SCOPE" ] || skip "Could not extract user scope"
    echo "# User scope: $USER_SCOPE"

    echo "# Step 2: Trying to run non-existent agent..."
    run $CLI_COMMAND run "$USER_SCOPE/nonexistent-agent-xyz123" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello"

    assert_failure
    # Should show agent not found error
    assert_output --partial "not found"
}

@test "vm0 run with scope/name:nonexistent-version shows error" {
    echo "# Step 1: Creating agent config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for version error"
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Composing agent..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Extract scope from compose output (avoids race condition with parallel tests)
    USER_SCOPE=$(echo "$output" | grep -oP '(created|exists): \K[a-z0-9-]+(?=/)' | head -1)
    echo "# Scope from compose output: $USER_SCOPE"

    [ -n "$USER_SCOPE" ] || {
        echo "# Failed to extract scope from compose output"
        echo "# Output was: $output"
        return 1
    }

    echo "# Step 3: Trying to run with non-existent version..."
    run $CLI_COMMAND run "$USER_SCOPE/$AGENT_NAME:deadbeef" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello"

    assert_failure
    # Should show version not found error
    assert_output --partial "Version not found"
}

# ============================================
# Cross-scope isolation tests
# ============================================

@test "vm0 run cannot access agent from different scope" {
    echo "# Creating agent config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for scope isolation"
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Composing agent in user's scope..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Trying to access agent with wrong scope prefix..."
    # Use a different scope that doesn't exist
    run $CLI_COMMAND run "other-user-scope/$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello"

    assert_failure
    # Should fail because the scope doesn't exist or agent isn't in that scope
    assert_output --partial "not found"
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
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Composing agent..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Setting up artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null
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
    provider: claude-code
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
    $CLI_COMMAND artifact init >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Step 4: Running with name:version format (no scope prefix)..."
    run $CLI_COMMAND run "$AGENT_NAME:$VERSION_ID" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello from name:version test"
    assert_success
}
