#!/usr/bin/env bats

load '../../helpers/setup'

# CLI validation and CRUD behavior is covered by command integration tests.
# These runner tests retain the deployed secret-masking boundary without
# passing the E2E user credential to the agent-facing Zero CLI.

setup_file() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"

    export VOLUME_NAME="e2e-vol-secret-${UNIQUE_ID}"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    seed_storage_fixture volume "$VOLUME_NAME" .
    cd - >/dev/null

    export ARTIFACT_NAME="e2e-secret-art-${UNIQUE_ID}"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    echo "test content" > test.txt
    seed_storage_fixture artifact "$ARTIFACT_NAME" .
    cd - >/dev/null

    export AGENT_MASK="e2e-secret-mask-${UNIQUE_ID}"
    cat > "$TEST_DIR/mask.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_MASK}:
    description: "E2E test agent for secret masking"
    framework: claude-code
    environment:
      MY_SECRET: "\${{ secrets.MY_SECRET }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF
    seed_compose_fixture "$TEST_DIR/mask.yaml" >/dev/null

    export AGENT_MULTI="e2e-secret-multi-${UNIQUE_ID}"
    cat > "$TEST_DIR/multi.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_MULTI}:
    description: "E2E test agent for multiple secrets"
    framework: claude-code
    environment:
      API_KEY: "\${{ secrets.API_KEY }}"
      CLI_SECRET: "\${{ secrets.CLI_SECRET }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF
    seed_compose_fixture "$TEST_DIR/multi.yaml" >/dev/null
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "direct run masks secret values in output" {
    local secret_value="secret-${UNIQUE_ID}"

    run run_compose_fixture "$AGENT_MASK" \
        "echo SECRET=\$MY_SECRET" \
        "$(jq -nc --arg secret "$secret_value" --arg artifact "$ARTIFACT_NAME" \
            '{
                secrets: {MY_SECRET: $secret},
                artifacts: [{name: $artifact, mountPath: "/home/user/workspace"}]
            }')"

    assert_success
    assert_output --partial "SECRET=***"
    refute_output --partial "SECRET=${secret_value}"
}

@test "direct run masks multiple supplied secrets in output" {
    local secret1_value="secret1-${UNIQUE_ID}"
    local secret2_value="secret2-${UNIQUE_ID}"

    run run_compose_fixture "$AGENT_MULTI" \
        "echo API_KEY=\$API_KEY && echo CLI_SECRET=\$CLI_SECRET" \
        "$(jq -nc \
            --arg secret1 "$secret1_value" \
            --arg secret2 "$secret2_value" \
            --arg artifact "$ARTIFACT_NAME" \
            '{
                secrets: {API_KEY: $secret1, CLI_SECRET: $secret2},
                artifacts: [{name: $artifact, mountPath: "/home/user/workspace"}]
            }')"

    assert_success
    assert_output --partial "API_KEY=***"
    assert_output --partial "CLI_SECRET=***"
    refute_output --partial "${secret1_value}"
    refute_output --partial "${secret2_value}"
}
