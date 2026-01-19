#!/usr/bin/env bats

load '../../helpers/setup'

# vm0 agent list and inspect command tests

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    # Use UUID for reliable uniqueness in parallel test runs
    export AGENT_NAME="e2e-agents-$(cat /proc/sys/kernel/random/uuid | head -c 8)"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# ============================================
# Help Tests
# ============================================

@test "vm0 agent list --help shows command description" {
    run $CLI_COMMAND agent list --help
    assert_success
    assert_output --partial "List all agent composes"
}

@test "vm0 agent ls alias works" {
    run $CLI_COMMAND agent ls --help
    assert_success
    assert_output --partial "List all agent composes"
}

@test "vm0 agent inspect --help shows command description" {
    run $CLI_COMMAND agent inspect --help
    assert_success
    assert_output --partial "Inspect an agent compose"
}

# ============================================
# List Command Tests
# ============================================

@test "vm0 agent list shows composed agent with table headers" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for list command"
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Run vm0 compose to create the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Run vm0 agent list"
    run $CLI_COMMAND agent list
    assert_success
    assert_output --partial "$AGENT_NAME"
    assert_output --partial "NAME"
    assert_output --partial "VERSION"
    assert_output --partial "UPDATED"
}

@test "vm0 agent list shows version as 8-char hex" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for version format"
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Run vm0 compose to create the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Run vm0 agent list and check version format"
    run $CLI_COMMAND agent list
    assert_success
    # Version should be 8 hex characters
    assert_output --regexp "[0-9a-f]{8}"
}

# ============================================
# Inspect Command Tests
# ============================================

@test "vm0 agent inspect shows agent details" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for inspect command"
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Run vm0 compose to create the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Run vm0 agent inspect"
    run $CLI_COMMAND agent inspect "$AGENT_NAME"
    assert_success
    assert_output --partial "Name:"
    assert_output --partial "Version:"
    assert_output --partial "Agents:"
    assert_output --partial "Provider:"
}

@test "vm0 agent inspect with version specifier" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for version specifier"
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Run vm0 compose and capture version ID"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
    VERSION=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')
    echo "# Captured version: $VERSION"

    echo "# Step 3: Run vm0 agent inspect with version specifier"
    run $CLI_COMMAND agent inspect "$AGENT_NAME:$VERSION"
    assert_success
    assert_output --partial "$VERSION"
}

@test "vm0 agent inspect with :latest tag" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for latest tag"
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Run vm0 compose"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Run vm0 agent inspect with :latest"
    run $CLI_COMMAND agent inspect "$AGENT_NAME:latest"
    assert_success
    assert_output --partial "Name:"
    assert_output --partial "Version:"
}

@test "vm0 agent inspect with --no-sources flag" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for no-sources flag"
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Run vm0 compose"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Run vm0 agent inspect with --no-sources flag"
    run $CLI_COMMAND agent inspect "$AGENT_NAME" --no-sources
    assert_success
    assert_output --partial "Name:"
}

# ============================================
# Error Handling Tests
# ============================================

@test "vm0 agent inspect fails for nonexistent agent" {
    run $CLI_COMMAND agent inspect "nonexistent-agent-12345"
    assert_failure
    assert_output --partial "not found"
}

@test "vm0 agent inspect fails for nonexistent version" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for version error"
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Run vm0 compose to create the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Run vm0 agent inspect with nonexistent version"
    run $CLI_COMMAND agent inspect "$AGENT_NAME:deadbeef"
    assert_failure
    assert_output --partial "Version not found"
}
