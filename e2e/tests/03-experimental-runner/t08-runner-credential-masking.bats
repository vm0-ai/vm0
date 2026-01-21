#!/usr/bin/env bats

# Test credential values are masked in agent output
# The runner is started by the CI workflow before these tests run.
#
# This test verifies that:
# 1. Credentials are fetched from the platform credential store
# 2. Credential values are masked in output (like secrets)
# 3. CLI --secrets take priority over credentials on collision
#
# BLACK BOX test - only interacts via CLI/API

load '../../helpers/setup.bash'

# Unique agent name for this test file
AGENT_NAME="e2e-runner-t08"

setup() {
    if [[ -z "$VM0_API_URL" ]]; then
        fail "VM0_API_URL not set"
    fi

    if [[ -z "$RUNNER_GROUP" ]]; then
        fail "RUNNER_GROUP not set - runner was not started by workflow"
    fi

    # Create unique volume for this test
    create_test_volume "e2e-vol-runner-t08"

    # Create unique test values
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export CRED_VALUE="cred-secret-${UNIQUE_ID}"
    export SECRET_VALUE="cli-secret-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-runner-cred-${UNIQUE_ID}"
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export TEST_CRED_NAME="E2E_CRED_MASK_${UNIQUE_ID//-/_}"
}

teardown() {
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
    if [ -n "$TEST_CONFIG" ] && [ -f "$TEST_CONFIG" ]; then
        rm -f "$TEST_CONFIG"
    fi
    # Clean up test credential
    $CLI_COMMAND experimental-credential delete -y "$TEST_CRED_NAME" 2>/dev/null || true
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

@test "Runner credential masking: credential values are masked in output" {
    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    # Step 1: Create a credential in the platform
    echo "# Creating credential: $TEST_CRED_NAME"
    run $CLI_COMMAND experimental-credential set "$TEST_CRED_NAME" "$CRED_VALUE"
    assert_success

    # Step 2: Create config that uses the credential
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for credential masking"
    provider: claude-code
    experimental_runner:
      group: ${RUNNER_GROUP}
    working_dir: /home/user/workspace
    environment:
      MY_CREDENTIAL: "\${{ credentials.${TEST_CRED_NAME} }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    setup_artifact

    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Running agent that echoes credential value..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo CRED=\$MY_CREDENTIAL"

    echo "# Output:"
    echo "$output"

    assert_success

    # Verify credential value is masked
    assert_output --partial "CRED=***"
    refute_output --partial "CRED=${CRED_VALUE}"
}

@test "Runner credential masking: CLI secrets take priority over credentials" {
    echo "# Using shared runner with group: ${RUNNER_GROUP}"

    # Step 1: Create a credential in the platform
    echo "# Creating credential: $TEST_CRED_NAME"
    run $CLI_COMMAND experimental-credential set "$TEST_CRED_NAME" "$CRED_VALUE"
    assert_success

    # Step 2: Create config that uses both a credential and a secret with same name
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for credential/secret priority"
    provider: claude-code
    experimental_runner:
      group: ${RUNNER_GROUP}
    working_dir: /home/user/workspace
    environment:
      API_KEY: "\${{ credentials.${TEST_CRED_NAME} }}"
      CLI_SECRET: "\${{ secrets.CLI_SECRET }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    setup_artifact

    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Running agent with CLI secret..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --secrets "CLI_SECRET=${SECRET_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo API_KEY=\$API_KEY && echo CLI_SECRET=\$CLI_SECRET"

    echo "# Output:"
    echo "$output"

    assert_success

    # Both credential and CLI secret should be masked
    assert_output --partial "API_KEY=***"
    assert_output --partial "CLI_SECRET=***"

    # Neither actual value should appear
    refute_output --partial "${CRED_VALUE}"
    refute_output --partial "${SECRET_VALUE}"
}
