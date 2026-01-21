#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="vm0-tpl-validation-${UNIQUE_ID}"
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG_TEMPLATE="$TEST_DIR/vm0-template-validation.yaml"

    # Create config dynamically with unique agent name
    cat > "$TEST_CONFIG_TEMPLATE" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "Test agent for template variable validation"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    volumes:
      - user-data:/home/user/data

volumes:
  user-data:
    name: "\${{ vars.userName }}-data"
    version: "latest"
EOF
}

teardown() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# Template variable validation tests for vm0 run

@test "vm0 run should fail when template variables are missing" {
    # First build the config
    run $CLI_COMMAND compose "$TEST_CONFIG_TEMPLATE"
    assert_success

    # Then try to run without providing template vars
    # Note: --artifact-name is required for run command, so provide a dummy one
    run $CLI_COMMAND run "$AGENT_NAME" --artifact-name test-artifact "echo hello"
    assert_failure
    assert_output --partial "Missing required template variables"
    assert_output --partial "userName"
}