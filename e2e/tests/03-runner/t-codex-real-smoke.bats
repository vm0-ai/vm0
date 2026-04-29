#!/usr/bin/env bats

# Real Codex smoke test — verifies actual codex CLI execution (not mock).
#
# Mirrors t27-real-claude-smoke.bats but for the codex framework. Requires
# `OPENAI_API_KEY` in the host environment and uses --debug-no-mock-codex
# to suppress USE_MOCK_CODEX forwarding so the real codex binary runs
# inside the sandbox.
#
# OPENAI_API_KEY is mandatory — CI injects it via secrets.OPENAI_API_KEY and
# local runs must export it. There is no skip path: if the key is missing,
# the test fails naturally when the CLI tries to use it.

load '../../helpers/setup'

setup_file() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-real-codex-${UNIQUE_ID}"
    export VOLUME_NAME="e2e-real-codex-vol-${UNIQUE_ID}"

    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > AGENTS.md << 'VOLEOF'
Real codex smoke test instructions.
VOLEOF
    $VM0_CLI volume init --name "$VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null

    cat > "$TEST_DIR/vm0-basic.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Real codex smoke test"
    framework: codex
    environment:
      OPENAI_API_KEY: "\${{ secrets.OPENAI_API_KEY }}"
    volumes:
      - codex-files:/home/user/.codex
    working_dir: /home/user/workspace
volumes:
  codex-files:
    name: $VOLUME_NAME
    version: latest
EOF

    $VM0_CLI compose "$TEST_DIR/vm0-basic.yaml" >/dev/null
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "t-codex-real-smoke-0: print sandbox codex version" {
    run $VM0_CLI run "$AGENT_NAME" \
        --secrets "OPENAI_API_KEY=$OPENAI_API_KEY" \
        --debug-no-mock-codex \
        "Run 'codex --version' with the shell tool and include the exact output"

    assert_success
    echo "# Sandbox codex version output:"
    echo "$output"
}

@test "t-codex-real-smoke-1: basic run with real codex" {
    run $VM0_CLI run "$AGENT_NAME" \
        --secrets "OPENAI_API_KEY=$OPENAI_API_KEY" \
        --debug-no-mock-codex \
        "Compute 123+456 and reply with exactly: RESULT=<answer>"

    assert_success
    assert_output --partial "◆ Codex Completed"
    assert_output --partial "RESULT=579"
}
