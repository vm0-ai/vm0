#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory for dynamic configs
    export TEST_DIR="$(mktemp -d)"
    # Use unique agent name with timestamp to avoid conflicts
    export AGENT_NAME="e2e-simplified-$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-simplified-artifact-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # Clean up temporary directory
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

# ============================================
# Provider auto-configuration tests
# ============================================

@test "vm0 compose with provider auto-config (image and working_dir)" {
    echo "# Creating config without image or working_dir..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with provider auto-config"
    framework: claude-code
EOF

    echo "# Running vm0 compose..."
    run $VM0_CLI compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Verifying compose succeeded..."
    assert_output --partial "Compose created"
}

@test "vm0 compose with explicit working_dir skips working_dir auto-config" {
    echo "# Creating config with explicit image and working_dir..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with explicit config"
    framework: claude-code
    working_dir: /custom/path
EOF

    echo "# Running vm0 compose..."
    run $VM0_CLI compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Verifying compose succeeded..."
    assert_output --partial "Compose"
}

@test "vm0 compose silently ignores apps field" {
    echo "# Creating config with legacy apps field..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with legacy apps field"
    framework: claude-code
    apps:
      - github
EOF

    echo "# Running vm0 compose..."
    run $VM0_CLI compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Verifying compose succeeded (apps field silently ignored)..."
    assert_output --partial "Compose"
}

# ============================================
# instructions tests
# ============================================

@test "vm0 compose with instructions uploads file" {
    echo "# Creating config with instructions..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    framework: claude-code
    instructions: AGENTS.md
EOF

    echo "# Creating AGENTS.md file..."
    cat > "$TEST_DIR/AGENTS.md" <<EOF
# Test Instructions

You are a test agent. Always respond with TEST_INSTRUCTIONS_LOADED.
EOF

    echo "# Running vm0 compose..."
    cd "$TEST_DIR"
    run $VM0_CLI compose vm0.yaml
    assert_success

    echo "# Verifying instructions upload..."
    assert_output --partial "Uploading instructions"
    assert_output --partial "Instructions"
}

@test "vm0 compose with instructions deduplicates unchanged content" {
    echo "# Creating config with instructions..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    framework: claude-code
    instructions: AGENTS.md
EOF

    echo "# Creating AGENTS.md file..."
    cat > "$TEST_DIR/AGENTS.md" <<EOF
# Test Instructions for Deduplication

This content should be deduplicated on second upload.
EOF

    echo "# First compose..."
    cd "$TEST_DIR"
    run $VM0_CLI compose vm0.yaml
    assert_success
    assert_output --partial "Instructions"

    echo "# Second compose with same content..."
    run $VM0_CLI compose vm0.yaml
    assert_success
    # Should show unchanged indicator
    assert_output --partial "unchanged"
}

# ============================================
# Run tests (verify files are mounted)
# ============================================

@test "vm0 run with instructions mounts CLAUDE.md file" {
    echo "# Creating config with instructions..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    framework: claude-code
    instructions: AGENTS.md
EOF

    echo "# Creating AGENTS.md with unique marker..."
    cat > "$TEST_DIR/AGENTS.md" <<EOF
# Test Instructions

UNIQUE_MARKER_FOR_E2E_TEST_${AGENT_NAME}
EOF

    echo "# Running vm0 compose..."
    cd "$TEST_DIR"
    run $VM0_CLI compose vm0.yaml
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $VM0_CLI artifact push
    assert_success

    echo "# Running agent to verify instructions is mounted..."
    # The instructions is mounted at /home/user/.claude/CLAUDE.md
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "cat /home/user/.claude/CLAUDE.md"
    assert_success

    echo "# Verifying output contains the marker from AGENTS.md..."
    assert_output --partial "UNIQUE_MARKER_FOR_E2E_TEST"
}

@test "vm0 run has gh cli installed by default" {
    echo "# Creating config without apps field..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    framework: claude-code
EOF

    echo "# Running vm0 compose..."
    run $VM0_CLI compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $VM0_CLI artifact push
    assert_success

    echo "# Running agent to verify gh cli is installed in base image..."
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "gh --version"
    assert_success

    echo "# Verifying gh version output..."
    assert_output --partial "gh version"
}
