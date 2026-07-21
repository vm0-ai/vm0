#!/usr/bin/env bats

# Test model-provider credential injection into container environment
#
# Verifies that an explicit runner provider type is honored by vm0 run and
# injected into the container as CLAUDE_CODE_OAUTH_TOKEN.

load '../../helpers/setup'

setup() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-mp-inject-${UNIQUE_ID}"

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Model provider credential injection test"
    framework: claude-code
EOF

    seed_compose_fixture "$TEST_DIR/vm0.yaml" >/dev/null
}

teardown() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "model-provider credential is injected into container" {
    zero_model_provider_id_by_type "claude-code-oauth-token" >/dev/null

    # GitHub Actions masks sk-ant-like values in logs, so emit a non-secret marker
    # only after verifying the injected token is present inside the container.
    run $VM0_CLI run "$AGENT_NAME" \
        --model-provider-type "claude-code-oauth-token" \
        "case \"\$CLAUDE_CODE_OAUTH_TOKEN\" in \"\"|\"***\") marker=MISMATCH ;; *) marker=OK ;; esac; printf 'INJECTED_%s\n' \"\$marker\""

    echo "$output"
    assert_success
    assert_output --partial "INJECTED_OK"
}
