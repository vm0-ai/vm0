#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create unique volume for this test
    create_test_volume "e2e-vol-t12"

    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export SECRET_VALUE="secret-value-${UNIQUE_ID}"
    export VAR_VALUE="var-value-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-env-test-${UNIQUE_ID}"
    export AGENT_NAME="vm0-env-expansion-${UNIQUE_ID}"
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export TEST_ENV_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_ARTIFACT_DIR/vm0-env-expansion.yaml"
}

# Helper to create config dynamically
create_env_expansion_config() {
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "Test agent for environment variable expansion"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      TEST_VAR: "\${{ vars.testVar }}"
      TEST_SECRET: "\${{ secrets.TEST_SECRET }}"
    volumes:
      - claude-files:/home/user/.claude

volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF
}

teardown() {
    # Clean up temporary directories
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
    if [ -n "$TEST_ENV_DIR" ] && [ -d "$TEST_ENV_DIR" ]; then
        rm -rf "$TEST_ENV_DIR"
    fi
    # Clean up test volume
    cleanup_test_volume
}

# Helper to create artifact for tests
setup_artifact() {
    # Create config dynamically (each test needs its own due to parallel execution)
    create_env_expansion_config
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1
}

# Environment variable expansion tests with --secrets flag

@test "vm0 run expands vars and secrets via --secrets flag" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Build the compose"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 3: Run with --vars and --secrets flags"
    run $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=${VAR_VALUE}" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        --verbose \
        "echo VAR=\$TEST_VAR && echo SECRET=\$TEST_SECRET"
    assert_success

    echo "# Step 4: Verify vars are expanded"
    assert_output --partial "VAR=${VAR_VALUE}"

    echo "# Step 5: Verify secrets are masked in output"
    # The secret value should be replaced with *** for security
    assert_output --partial "SECRET=***"
    refute_output --partial "SECRET=${SECRET_VALUE}"
}

# Note: The following tests have been moved to Route Integration tests
# (apps/web/app/api/agent/runs/__tests__/route.test.ts):
#
# Validation section:
#    - "should fail run when required secrets are not provided"
#    - "should fail run when only some secrets are provided"
#    - "should succeed when all required secrets are provided"
#
# Session Continue section:
#    - 404 not found, 404 different user (security)
#
# Checkpoint Resume section:
#    - 404 not found, 404 different user (security)
#
# Removed E2E tests (covered by route integration tests):
#    - "vm0 run with multiple --secrets flags" - validates same code path as Test 1
#    - "vm0 run continue requires secrets to be re-provided"
#    - "vm0 run resume requires secrets to be re-provided"
#
# This E2E test (1 vm0 run) validates the happy path end-to-end, while route
# integration tests cover error cases with faster feedback.
