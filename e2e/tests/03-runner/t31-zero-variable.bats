#!/usr/bin/env bats

load '../../helpers/setup'

# CLI validation and CRUD behavior is covered by command integration tests.
# These runner tests keep the deployed variable-expansion boundary and use the
# E2E-only API credential for host-side fixture setup.

setup_file() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"

    export VOLUME_NAME="e2e-vol-var-${UNIQUE_ID}"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    seed_storage_fixture volume "$VOLUME_NAME" .
    cd - >/dev/null

    export ARTIFACT_NAME="e2e-var-art-${UNIQUE_ID}"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    echo "test content" > test.txt
    seed_storage_fixture artifact "$ARTIFACT_NAME" .
    cd - >/dev/null

    local var_safe_id="${UNIQUE_ID//-/_}"
    export VAR_NAME_EXPAND="TEST_VAR_EXPAND_${var_safe_id}"
    export VAR_NAME_OVERRIDE="TEST_VAR_OVERRIDE_${var_safe_id}"

    export AGENT_EXPAND="e2e-var-expand-${UNIQUE_ID}"
    cat > "$TEST_DIR/expand.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_EXPAND}:
    description: "E2E test agent for variable expansion"
    framework: claude-code
    environment:
      MY_VAR: "\${{ vars.${VAR_NAME_EXPAND} }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF
    seed_compose_fixture "$TEST_DIR/expand.yaml" >/dev/null

    export AGENT_OVERRIDE="e2e-var-override-${UNIQUE_ID}"
    cat > "$TEST_DIR/override.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_OVERRIDE}:
    description: "Agent with direct variable override"
    framework: claude-code
    environment:
      MY_VAR: "\${{ vars.${VAR_NAME_OVERRIDE} }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF
    seed_compose_fixture "$TEST_DIR/override.yaml" >/dev/null
}

teardown_file() {
    delete_e2e_variable "$VAR_NAME_EXPAND" 2>/dev/null || true
    delete_e2e_variable "$VAR_NAME_OVERRIDE" 2>/dev/null || true
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "direct run expands server-stored variables" {
    local var_value="var-value-${UNIQUE_ID}"
    set_e2e_variable "$VAR_NAME_EXPAND" "$var_value"

    run run_compose_fixture "$AGENT_EXPAND" \
        "echo MY_VAR=\$MY_VAR" \
        "$(jq -nc --arg artifact "$ARTIFACT_NAME" \
            '{artifacts: [{name: $artifact, mountPath: "/home/user/workspace"}]}')"

    assert_success
    assert_output --partial "MY_VAR=${var_value}"
}

@test "direct run vars override server-stored variables" {
    local server_value="server-value-${UNIQUE_ID}"
    local direct_value="direct-value-${UNIQUE_ID}"
    set_e2e_variable "$VAR_NAME_OVERRIDE" "$server_value"

    run run_compose_fixture "$AGENT_OVERRIDE" \
        "echo MY_VAR=\$MY_VAR" \
        "$(jq -nc \
            --arg variableName "$VAR_NAME_OVERRIDE" \
            --arg variableValue "$direct_value" \
            --arg artifact "$ARTIFACT_NAME" \
            '{
                vars: {($variableName): $variableValue},
                artifacts: [{name: $artifact, mountPath: "/home/user/workspace"}]
            }')"

    assert_success
    assert_output --partial "MY_VAR=${direct_value}"
    refute_output --partial "MY_VAR=${server_value}"
}
