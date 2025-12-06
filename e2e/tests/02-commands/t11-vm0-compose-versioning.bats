#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory for dynamic configs
    export TEST_DIR="$(mktemp -d)"
    # Use unique agent name with timestamp to avoid conflicts
    export AGENT_NAME="e2e-versioning-$(date +%s)"
}

teardown() {
    # Clean up temporary directory
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

# ============================================
# vm0 build versioning tests
# ============================================

@test "vm0 build should display version ID" {
    echo "# Creating config file..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for version display"
    provider: claude-code
    image: vm0-claude-code-dev
    working_dir: /home/user/workspace
EOF

    echo "# Running vm0 build..."
    run $CLI_COMMAND build "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Verifying output contains Version..."
    assert_output --partial "Version:"
    # Version should be 8 hex characters (short form of SHA-256)
    assert_output --regexp "Version:[ ]+[0-9a-f]{8}"
}

@test "vm0 build with same content should return 'version exists'" {
    echo "# Creating config file..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for deduplication"
    provider: claude-code
    image: vm0-claude-code-dev
    working_dir: /home/user/workspace
EOF

    echo "# First build..."
    run $CLI_COMMAND build "$TEST_DIR/vm0.yaml"
    assert_success
    # Extract version from first build
    VERSION1=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')

    echo "# Version 1: $VERSION1"

    echo "# Second build with identical content..."
    run $CLI_COMMAND build "$TEST_DIR/vm0.yaml"
    assert_success
    # Should indicate version already exists (content deduplication)
    assert_output --partial "version exists"

    # Extract version from second build
    VERSION2=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')
    echo "# Version 2: $VERSION2"

    # Same content should produce same version ID
    [ "$VERSION1" = "$VERSION2" ] || {
        echo "# ERROR: Versions should match for identical content"
        echo "#   Version 1: $VERSION1"
        echo "#   Version 2: $VERSION2"
        return 1
    }
}

@test "vm0 build with different content should create new version" {
    echo "# Creating initial config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Initial description"
    provider: claude-code
    image: vm0-claude-code-dev
    working_dir: /home/user/workspace
EOF

    echo "# First build..."
    run $CLI_COMMAND build "$TEST_DIR/vm0.yaml"
    assert_success
    VERSION1=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')
    echo "# Version 1: $VERSION1"

    echo "# Modifying config with different description..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Updated description"
    provider: claude-code
    image: vm0-claude-code-dev
    working_dir: /home/user/workspace
EOF

    echo "# Second build with different content..."
    run $CLI_COMMAND build "$TEST_DIR/vm0.yaml"
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

@test "vm0 build version ID is deterministic (key order independent)" {
    echo "# Creating config with keys in one order..."
    cat > "$TEST_DIR/vm0-a.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Deterministic test"
    provider: claude-code
    image: vm0-claude-code-dev
    working_dir: /home/user/workspace
EOF

    echo "# First build..."
    run $CLI_COMMAND build "$TEST_DIR/vm0-a.yaml"
    assert_success
    VERSION1=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')
    echo "# Version 1: $VERSION1"

    echo "# Creating config with keys in different order (same content)..."
    cat > "$TEST_DIR/vm0-b.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    working_dir: /home/user/workspace
    image: vm0-claude-code-dev
    provider: claude-code
    description: "Deterministic test"
EOF

    echo "# Second build with same content, different key order..."
    run $CLI_COMMAND build "$TEST_DIR/vm0-b.yaml"
    assert_success
    VERSION2=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')
    echo "# Version 2: $VERSION2"

    # Same content with different key order should produce same version ID
    [ "$VERSION1" = "$VERSION2" ] || {
        echo "# ERROR: Version ID should be key-order independent"
        echo "#   Version 1: $VERSION1"
        echo "#   Version 2: $VERSION2"
        return 1
    }
}

# ============================================
# vm0 run with version specifier tests
# ============================================

@test "vm0 run with version specifier runs specific version" {
    export ARTIFACT_NAME="e2e-versioning-artifact-$(date +%s)"

    echo "# Creating initial config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Version 1"
    provider: claude-code
    image: vm0-claude-code-dev
    working_dir: /home/user/workspace
EOF

    echo "# Building version 1..."
    run $CLI_COMMAND build "$TEST_DIR/vm0.yaml"
    assert_success
    VERSION1=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')
    echo "# Version 1: $VERSION1"

    echo "# Creating updated config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Version 2"
    provider: claude-code
    image: vm0-claude-code-dev
    working_dir: /home/user/workspace
EOF

    echo "# Building version 2..."
    run $CLI_COMMAND build "$TEST_DIR/vm0.yaml"
    assert_success
    VERSION2=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')
    echo "# Version 2: $VERSION2"

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Running with specific version (version 1)..."
    run $CLI_COMMAND run "$AGENT_NAME:$VERSION1" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello"
    assert_success
}

@test "vm0 run with :latest tag runs HEAD version" {
    export ARTIFACT_NAME="e2e-versioning-latest-$(date +%s)"

    echo "# Creating config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Latest version test"
    provider: claude-code
    image: vm0-claude-code-dev
    working_dir: /home/user/workspace
EOF

    echo "# Building agent..."
    run $CLI_COMMAND build "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Running with :latest tag..."
    run $CLI_COMMAND run "$AGENT_NAME:latest" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello"
    assert_success
}

@test "vm0 run with nonexistent version shows error" {
    export ARTIFACT_NAME="e2e-versioning-error-$(date +%s)"

    echo "# Creating config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Error test"
    provider: claude-code
    image: vm0-claude-code-dev
    working_dir: /home/user/workspace
EOF

    echo "# Building agent..."
    run $CLI_COMMAND build "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Running with nonexistent version (should fail before artifact check)..."
    run $CLI_COMMAND run "$AGENT_NAME:deadbeef" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello"
    assert_failure
    assert_output --partial "Version not found"
}

@test "vm0 run without version specifier runs HEAD (backward compatible)" {
    export ARTIFACT_NAME="e2e-versioning-compat-$(date +%s)"

    echo "# Creating config..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Backward compatibility test"
    provider: claude-code
    image: vm0-claude-code-dev
    working_dir: /home/user/workspace
EOF

    echo "# Building agent..."
    run $CLI_COMMAND build "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Running without version specifier (should use HEAD)..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello"
    assert_success
}
