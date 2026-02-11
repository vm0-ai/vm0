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
# vm0 compose versioning tests
#
# Integration tests verify the full compose workflow.
# Unit tests for hashing, deduplication, and error handling
# are in: turbo/apps/cli/src/__tests__/compose-versioning.test.ts
# ============================================

@test "vm0 compose should display version ID" {
    echo "# Creating config file..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for version display"
    framework: claude-code
    experimental_runner:
      group: ${RUNNER_GROUP}
    working_dir: /home/user/workspace
EOF

    echo "# Running vm0 compose..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Verifying output contains Version..."
    assert_output --partial "Version:"
    # Version should be 8 hex characters (short form of SHA-256)
    assert_output --regexp "Version:[ ]+[0-9a-f]{8}"
}

@test "vm0 compose with different content should create new version" {
    echo "# Creating initial config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Initial description"
    framework: claude-code
    experimental_runner:
      group: ${RUNNER_GROUP}
    working_dir: /home/user/workspace
EOF

    echo "# First compose..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
    VERSION1=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')
    echo "# Version 1: $VERSION1"

    echo "# Modifying config with different description..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Updated description"
    framework: claude-code
    experimental_runner:
      group: ${RUNNER_GROUP}
    working_dir: /home/user/workspace
EOF

    echo "# Second compose with different content..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
    # Should indicate new version created
    assert_output --partial "Compose created"

    VERSION2=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')
    echo "# Version 2: $VERSION2"

    # Different content should produce different version ID
    [ "$VERSION1" != "$VERSION2" ] || {
        echo "# ERROR: Versions should differ for different content"
        echo "#   Version 1: $VERSION1"
        echo "#   Version 2: $VERSION2"
        return 1
    }
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
    experimental_runner:
      group: ${RUNNER_GROUP}
    working_dir: /home/user/workspace
EOF

    echo "# Building version 1..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
    VERSION1=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')
    echo "# Version 1: $VERSION1"

    echo "# Creating updated config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Version 2"
    framework: claude-code
    experimental_runner:
      group: ${RUNNER_GROUP}
    working_dir: /home/user/workspace
EOF

    echo "# Building version 2..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
    VERSION2=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')
    echo "# Version 2: $VERSION2"

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Running with specific version (version 1)..."
    run $CLI_COMMAND run "$AGENT_NAME:$VERSION1" \
        --artifact-name "$ARTIFACT_NAME" \
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
    experimental_runner:
      group: ${RUNNER_GROUP}
    working_dir: /home/user/workspace
EOF

    echo "# Building agent..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Running with :latest tag..."
    run $CLI_COMMAND run "$AGENT_NAME:latest" \
        --artifact-name "$ARTIFACT_NAME" \
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
    experimental_runner:
      group: ${RUNNER_GROUP}
    working_dir: /home/user/workspace
EOF

    echo "# Building agent..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Running without version specifier (should use HEAD)..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello"
    assert_success
}
