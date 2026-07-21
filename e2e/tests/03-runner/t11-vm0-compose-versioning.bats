#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory for dynamic configs
    export TEST_DIR="$(mktemp -d)"
    # Use UUID for reliable uniqueness in parallel test runs
    export AGENT_NAME="e2e-versioning-$(cat /proc/sys/kernel/random/uuid | head -c 8)"
}

teardown() {
    # Clean up temporary directory
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

# ============================================
# vm0 run with version specifier tests
# ============================================

@test "vm0 run with version specifier runs specific version" {
    export ARTIFACT_NAME="e2e-versioning-artifact-$(date +%s%3N)-$RANDOM"

    echo "# Creating initial config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Version 1"
    framework: claude-code
EOF

    echo "# Building version 1..."
    run seed_compose_fixture "$TEST_DIR/vm0.yaml"
    assert_success
    VERSION1=$(echo "$output" | jq -r '.versionId')
    echo "# Version 1: $VERSION1"

    echo "# Creating updated config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Version 2"
    framework: claude-code
EOF

    echo "# Building version 2..."
    run seed_compose_fixture "$TEST_DIR/vm0.yaml"
    assert_success
    VERSION2=$(echo "$output" | jq -r '.versionId')
    echo "# Version 2: $VERSION2"

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success

    echo "# Running with specific version (version 1)..."
    run $VM0_CLI run "$AGENT_NAME:$VERSION1" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo hello"
    assert_success
}

@test "vm0 run with :latest tag runs HEAD version" {
    export ARTIFACT_NAME="e2e-versioning-latest-$(date +%s%3N)-$RANDOM"

    echo "# Creating config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Latest version test"
    framework: claude-code
EOF

    echo "# Building agent..."
    run seed_compose_fixture "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success

    echo "# Running with :latest tag..."
    run $VM0_CLI run "$AGENT_NAME:latest" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo hello"
    assert_success
}

@test "vm0 run without version specifier runs HEAD (backward compatible)" {
    export ARTIFACT_NAME="e2e-versioning-compat-$(date +%s%3N)-$RANDOM"

    echo "# Creating config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Backward compatibility test"
    framework: claude-code
EOF

    echo "# Building agent..."
    run seed_compose_fixture "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success

    echo "# Running without version specifier (should use HEAD)..."
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo hello"
    assert_success
}
