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
# Run tests (verify files are mounted)
# ============================================

@test "direct run with instructions mounts CLAUDE.md file" {
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

    echo "# Seeding compose fixture..."
    cd "$TEST_DIR"
    run seed_compose_fixture vm0.yaml
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success

    echo "# Running agent to verify instructions is mounted..."
    # The instructions is mounted at /home/user/.claude/CLAUDE.md
    run run_compose_fixture "$AGENT_NAME" \
        "Run the exact Bash command below, wait for it to finish, and include its output:
cat /home/user/.claude/CLAUDE.md" \
        "$(jq -nc --arg name "$ARTIFACT_NAME" \
            '{artifacts: [{name: $name, mountPath: "/home/user/workspace"}]}')"
    assert_success

    echo "# Verifying output contains the marker from AGENTS.md..."
    assert_output --partial "UNIQUE_MARKER_FOR_E2E_TEST"
}

@test "direct run has gh cli installed by default" {
    echo "# Creating config without apps field..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    framework: claude-code
EOF

    echo "# Seeding compose fixture..."
    run seed_compose_fixture "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success

    echo "# Running agent to verify gh cli is installed in base image..."
    run run_compose_fixture "$AGENT_NAME" \
        "Run the exact Bash command below, wait for it to finish, and include its output:
gh --version" \
        "$(jq -nc --arg name "$ARTIFACT_NAME" \
            '{artifacts: [{name: $name, mountPath: "/home/user/workspace"}]}')"
    assert_success

    echo "# Verifying gh version output..."
    assert_output --partial "gh version"
}
