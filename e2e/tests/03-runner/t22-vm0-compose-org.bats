#!/usr/bin/env bats

# Test compose name resolution in vm0 run.
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
EOF

    echo "# Step 2: Seeding compose fixture..."
    run seed_compose_fixture "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Setting up artifact..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success

    echo "# Step 4: Running with name format..."
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo hello from name test"
    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "hello from name test"
}
