#!/usr/bin/env bats

# Test model-provider credential injection into container environment
#
# Verifies that an explicit runner provider type is honored by direct runs and
# its real credential is injected into the container.

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
    if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
        skip "ANTHROPIC_API_KEY not set"
    fi
    configure_e2e_model_provider "anthropic-api-key" "$ANTHROPIC_API_KEY"
    zero_model_provider_id_by_type "anthropic-api-key" >/dev/null

    # GitHub Actions masks sk-ant-like values in logs, so emit a non-secret marker
    # only after verifying the injected token is present inside the container.
    run run_compose_fixture "$AGENT_NAME" \
        "Run this exact Bash command and include its output: case \"\$ANTHROPIC_API_KEY\" in \"\"|\"***\") marker=MISMATCH ;; *) marker=OK ;; esac; printf 'INJECTED_%s\\n' \"\$marker\"" \
        '{"modelProviderType":"anthropic-api-key"}'

    echo "$output"
    assert_success
    assert_output --partial "INJECTED_OK"
}
