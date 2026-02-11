#!/usr/bin/env bats

# Test model-provider credential injection into container environment
#
# Verifies that the stable model-provider set by ser-t03 is correctly
# injected into the container as CLAUDE_CODE_OAUTH_TOKEN.

load '../../helpers/setup'

setup() {
    create_test_volume "e2e-vol-t30"

    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="mp-inject-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-mp-inject-${UNIQUE_ID}"
    export TEST_DIR="$(mktemp -d)"
}

teardown() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
    cleanup_test_volume
}

@test "model-provider credential is injected into container" {
    # Create config (uses default model-provider from ser-t03)
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}:
    description: "Test model-provider injection"
    framework: claude-code
    experimental_runner:
      group: ${RUNNER_GROUP}
    working_dir: /home/user/workspace
    volumes:
      - claude-files:/home/user/.claude

volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    # Create artifact
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1

    # Build and run
    $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"

    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo INJECTED=\$CLAUDE_CODE_OAUTH_TOKEN"

    assert_success
    assert_output --partial "INJECTED=***"
}
