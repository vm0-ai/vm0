#!/usr/bin/env bats

load '../../helpers/setup'

# vm0 agent list and status command tests (Happy Path Only)
#
# Note: Help/alias tests (command description, name, alias) have been moved to unit tests:
# turbo/apps/cli/src/__tests__/agent-commands.test.ts
#
# Error handling tests have been moved to CLI integration tests:
# turbo/apps/cli/src/commands/agent/__tests__/status.test.ts
#   - "should exit with error when compose not found" (nonexistent agent)
#   - "should exit with error when version not found" (nonexistent version)
#
# This file contains E2E tests that require actual API interaction.

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
# Environment Variable Display Tests
# ============================================

@test "vm0 agent status shows secrets from environment" {
    echo "# Step 1: Create vm0.yaml with secrets"
    cat > "$TEST_DIR/vm0.yaml" <<'EOF'
version: "1.0"

agents:
  $AGENT_NAME:
    framework: claude-code
    environment:
      API_KEY: "${{ secrets.MY_API_KEY }}"
      AUTH_TOKEN: "${{ secrets.AUTH_TOKEN }}"
EOF
    # Replace $AGENT_NAME in the file
    sed -i "s/\$AGENT_NAME/$AGENT_NAME/g" "$TEST_DIR/vm0.yaml"

    echo "# Step 2: Run vm0 compose"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml" --yes
    assert_success

    echo "# Step 3: Run vm0 agent status and verify secrets are displayed"
    run $CLI_COMMAND agent status "$AGENT_NAME" --no-sources
    assert_success
    assert_output --partial "Secrets:"
    assert_output --partial "MY_API_KEY"
    assert_output --partial "AUTH_TOKEN"
}

@test "vm0 agent status shows vars from environment" {
    echo "# Step 1: Create vm0.yaml with vars"
    cat > "$TEST_DIR/vm0.yaml" <<'EOF'
version: "1.0"

agents:
  $AGENT_NAME:
    framework: claude-code
    environment:
      DEBUG_MODE: "${{ vars.DEBUG }}"
      LOG_LEVEL: "${{ vars.LOG_LEVEL }}"
EOF
    # Replace $AGENT_NAME in the file
    sed -i "s/\$AGENT_NAME/$AGENT_NAME/g" "$TEST_DIR/vm0.yaml"

    echo "# Step 2: Run vm0 compose"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Run vm0 agent status and verify vars are displayed"
    run $CLI_COMMAND agent status "$AGENT_NAME" --no-sources
    assert_success
    assert_output --partial "Vars:"
    assert_output --partial "DEBUG"
    assert_output --partial "LOG_LEVEL"
}

@test "vm0 agent status shows credentials from environment" {
    echo "# Step 1: Create vm0.yaml with credentials"
    cat > "$TEST_DIR/vm0.yaml" <<'EOF'
version: "1.0"

agents:
  $AGENT_NAME:
    framework: claude-code
    environment:
      DATABASE_URL: "${{ credentials.DB_URL }}"
EOF
    # Replace $AGENT_NAME in the file
    sed -i "s/\$AGENT_NAME/$AGENT_NAME/g" "$TEST_DIR/vm0.yaml"

    echo "# Step 2: Run vm0 compose"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Run vm0 agent status and verify credentials are displayed"
    run $CLI_COMMAND agent status "$AGENT_NAME" --no-sources
    assert_success
    assert_output --partial "Credentials:"
    assert_output --partial "DB_URL"
}

@test "vm0 agent status shows mixed secrets vars and credentials" {
    echo "# Step 1: Create vm0.yaml with mixed environment variables"
    cat > "$TEST_DIR/vm0.yaml" <<'EOF'
version: "1.0"

agents:
  $AGENT_NAME:
    framework: claude-code
    environment:
      API_KEY: "${{ secrets.API_KEY }}"
      DEBUG: "${{ vars.DEBUG }}"
      DB_URL: "${{ credentials.DB_URL }}"
      STATIC_VALUE: "hardcoded"
EOF
    # Replace $AGENT_NAME in the file
    sed -i "s/\$AGENT_NAME/$AGENT_NAME/g" "$TEST_DIR/vm0.yaml"

    echo "# Step 2: Run vm0 compose"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml" --yes
    assert_success

    echo "# Step 3: Run vm0 agent status and verify all types are displayed"
    run $CLI_COMMAND agent status "$AGENT_NAME" --no-sources
    assert_success
    assert_output --partial "Secrets:"
    assert_output --partial "API_KEY"
    assert_output --partial "Vars:"
    assert_output --partial "DEBUG"
    assert_output --partial "Credentials:"
    assert_output --partial "DB_URL"
}

# ============================================
# Delete Command Tests
# ============================================

@test "vm0 agent delete removes agent with --yes flag" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for delete command"
    framework: claude-code
EOF

    echo "# Step 2: Run vm0 compose to create the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Verify agent exists in list"
    run $CLI_COMMAND agent list
    assert_success
    assert_output --partial "$AGENT_NAME"

    echo "# Step 4: Delete the agent with --yes flag"
    run $CLI_COMMAND agent delete "$AGENT_NAME" --yes
    assert_success
    assert_output --partial "deleted"

    echo "# Step 5: Verify agent no longer exists in list"
    run $CLI_COMMAND agent list
    assert_success
    refute_output --partial "$AGENT_NAME"
}

@test "vm0 agent rm alias works for delete" {
    echo "# Step 1: Create vm0.yaml config file"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for rm alias"
    framework: claude-code
EOF

    echo "# Step 2: Run vm0 compose to create the agent"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Delete the agent using rm alias"
    run $CLI_COMMAND agent rm "$AGENT_NAME" --yes
    assert_success
    assert_output --partial "deleted"
}

@test "vm0 agent delete fails for nonexistent agent" {
    echo "# Step 1: Try to delete a nonexistent agent"
    run $CLI_COMMAND agent delete "nonexistent-agent-$(cat /proc/sys/kernel/random/uuid | head -c 8)" --yes
    assert_failure
    assert_output --partial "not found"
}
