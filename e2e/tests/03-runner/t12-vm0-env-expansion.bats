#!/usr/bin/env bats

load '../../helpers/setup'

# ============================================================================
# File-level setup: create volume, compose config, and artifact ONCE.
# ============================================================================

setup_file() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"

    # Create volume once
    export VOLUME_NAME="e2e-vol-t12-${UNIQUE_ID}"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    $VM0_CLI volume init --name "$VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null

    # Create artifact once
    export ARTIFACT_NAME="e2e-env-test-${UNIQUE_ID}"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test content" > test.txt
    $VM0_CLI artifact push >/dev/null 2>&1
    cd - >/dev/null

    # Create compose config once
    export AGENT_NAME="vm0-env-expansion-${UNIQUE_ID}"
    export TEST_CONFIG="$TEST_DIR/vm0-env-expansion.yaml"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "Test agent for environment variable expansion"
    framework: claude-code
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
    $VM0_CLI compose "$TEST_CONFIG" >/dev/null
}

teardown_file() {
    # Clean up shared test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# Environment variable expansion tests with --secrets flag

@test "vm0 run expands vars and secrets via --secrets flag" {
    local secret_value="secret-value-${UNIQUE_ID}"
    local var_value="var-value-${UNIQUE_ID}"

    echo "# Running with --vars and --secrets flags"
    run $VM0_CLI run "$AGENT_NAME" \
        --vars "testVar=${var_value}" \
        --secrets "TEST_SECRET=${secret_value}" \
        --artifact "$ARTIFACT_NAME" \
        --verbose \
        "echo VAR=\$TEST_VAR && echo SECRET=\$TEST_SECRET"
    assert_success

    echo "# Verify vars are expanded"
    assert_output --partial "VAR=${var_value}"

    echo "# Verify secrets are masked in output"
    # The secret value should be replaced with *** for security
    assert_output --partial "SECRET=***"
    refute_output --partial "SECRET=${secret_value}"
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
