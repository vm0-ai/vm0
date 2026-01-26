#!/usr/bin/env bats

load '../../helpers/setup'

# vm0 agent list and status command tests
#
# Note: Help/alias tests (command description, name, alias) have been moved to unit tests:
# turbo/apps/cli/src/__tests__/agent-commands.test.ts
#
# This file contains integration tests that require actual API interaction.

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
# List Command Tests
# ============================================

@test "vm0 agent list shows composed agent with table headers" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for list command"
    framework: claude-code
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
    framework: claude-code
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
# Status Command Tests
# ============================================

@test "vm0 agent status shows agent details" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for status command"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Run vm0 compose to create the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Run vm0 agent status"
    run $CLI_COMMAND agent status "$AGENT_NAME"
    assert_success
    assert_output --partial "Name:"
    assert_output --partial "Version:"
    assert_output --partial "Agents:"
    assert_output --partial "Framework:"
}

@test "vm0 agent status with version specifier" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for version specifier"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Run vm0 compose and capture version ID"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
    VERSION=$(echo "$output" | grep -oP 'Version:\s+\K[0-9a-f]+')
    echo "# Captured version: $VERSION"

    echo "# Step 3: Run vm0 agent status with version specifier"
    run $CLI_COMMAND agent status "$AGENT_NAME:$VERSION"
    assert_success
    assert_output --partial "$VERSION"
}

@test "vm0 agent status with :latest tag" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for latest tag"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Run vm0 compose"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Run vm0 agent status with :latest"
    run $CLI_COMMAND agent status "$AGENT_NAME:latest"
    assert_success
    assert_output --partial "Name:"
    assert_output --partial "Version:"
}

@test "vm0 agent status with --no-sources flag" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for no-sources flag"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Run vm0 compose"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Run vm0 agent status with --no-sources flag"
    run $CLI_COMMAND agent status "$AGENT_NAME" --no-sources
    assert_success
    assert_output --partial "Name:"
}

# ============================================
# Error Handling Tests
# ============================================

@test "vm0 agent status fails for nonexistent agent" {
    run $CLI_COMMAND agent status "nonexistent-agent-12345"
    assert_failure
    assert_output --partial "not found"
}

@test "vm0 agent status fails for nonexistent version" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for version error"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
EOF

    echo "# Step 2: Run vm0 compose to create the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Run vm0 agent status with nonexistent version"
    run $CLI_COMMAND agent status "$AGENT_NAME:deadbeef"
    assert_failure
    assert_output --partial "Version not found"
}
