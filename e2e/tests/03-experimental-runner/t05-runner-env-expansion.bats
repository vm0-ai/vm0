#!/usr/bin/env bats

# Test Runner environment variable expansion
# The runner is started by the CI workflow before these tests run.
#
# This test verifies that:
# 1. Vars and secrets are expanded in agent environment
# 2. Secrets are masked in output
# 3. Session continuity behavior for secrets
#
# Note: Missing secrets/vars validation is tested in unit tests:
# turbo/apps/web/src/lib/run/environment/__tests__/expand-environment.test.ts
#
# BLACK BOX test - only interacts via CLI/API

load '../../helpers/setup.bash'

# Unique agent name for this test file
AGENT_NAME="e2e-runner-t05"

setup() {
    if [[ -z "$VM0_API_URL" ]]; then
        fail "VM0_API_URL not set"
    fi

    if [[ -z "$RUNNER_GROUP" ]]; then
        fail "RUNNER_GROUP not set - runner was not started by workflow"
    fi

    # Create unique volume for this test
    create_test_volume "e2e-vol-runner-t05"

    # Create unique test values
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export SECRET_VALUE="secret-value-${UNIQUE_ID}"
    export VAR_VALUE="var-value-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-runner-env-${UNIQUE_ID}"
    export TEST_ARTIFACT_DIR="$(mktemp -d)"

    # Create inline config with runner and environment variables
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for env expansion with runner"
    framework: claude-code
    experimental_runner:
      group: ${RUNNER_GROUP}
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
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
    if [ -n "$TEST_CONFIG" ] && [ -f "$TEST_CONFIG" ]; then
        rm -f "$TEST_CONFIG"
    fi
    # Clean up test volume
    cleanup_test_volume
}

# Helper to create artifact
setup_artifact() {
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1
}

@test "Runner env: compose agent with environment variables" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "Runner env: expands vars and secrets via --secrets flag" {
    echo "# Using shared runner with group: ${RUNNER_GROUP}"
    setup_artifact

    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Running with --vars and --secrets..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=${VAR_VALUE}" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        --verbose \
        "echo VAR=\$TEST_VAR && echo SECRET=\$TEST_SECRET"

    echo "# Output:"
    echo "$output"

    assert_success

    # Verify vars are expanded
    assert_output --partial "VAR=${VAR_VALUE}"

    # Verify secrets are masked
    assert_output --partial "SECRET=***"
    refute_output --partial "SECRET=${SECRET_VALUE}"
}

@test "Runner env: loads secrets from environment variables" {
    echo "# Using shared runner with group: ${RUNNER_GROUP}"
    setup_artifact

    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Running with secret in environment..."
    export TEST_SECRET="${SECRET_VALUE}"
    run $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=${VAR_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        --verbose \
        "echo VAR=\$TEST_VAR && echo SECRET=\$TEST_SECRET"

    echo "# Output:"
    echo "$output"

    assert_success
    assert_output --partial "VAR=${VAR_VALUE}"
    assert_output --partial "SECRET=***"
}

@test "Runner env: continue requires secrets to be re-provided" {
    echo "# Using shared runner with group: ${RUNNER_GROUP}"
    setup_artifact

    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 1: Initial run with secrets..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=${VAR_VALUE}" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        --verbose \
        "echo INITIAL && echo SECRET=\$TEST_SECRET"
    assert_success
    assert_output --partial "INITIAL"
    assert_output --partial "SECRET=***"

    echo "# Step 2: Extract session ID..."
    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    [ -n "$SESSION_ID" ] || {
        echo "# Failed to extract session ID"
        return 1
    }
    echo "# Session ID: $SESSION_ID"

    echo "# Step 3: Continue WITHOUT secrets should fail..."
    run $CLI_COMMAND run continue "$SESSION_ID" "echo CONTINUED"

    echo "# Output:"
    echo "$output"

    assert_failure
    assert_output --partial "Missing required secrets: TEST_SECRET"

    echo "# Step 4: Continue WITH secrets should succeed..."
    run $CLI_COMMAND run continue "$SESSION_ID" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        --verbose \
        "echo CONTINUED && echo SECRET=\$TEST_SECRET"
    assert_success
    assert_output --partial "CONTINUED"
    assert_output --partial "SECRET=***"
}
