#!/usr/bin/env bats

# Test mock-claude @ECHO@ JSONL fixture mode end-to-end.
# Verifies the CLI -> API -> runner -> sandbox pipeline can replay a supplied
# Claude-compatible JSONL stream without invoking the real Claude CLI.

load '../../helpers/setup'

setup_file() {
    export AGENT_NAME="e2e-t58-$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"

    create_test_volume "e2e-vol-t58"
    export SHARED_VOLUME_NAME="$VOLUME_NAME"
    export SHARED_VOLUME_DIR="$TEST_VOLUME_DIR"

    export TEST_CONFIG="$TEST_DIR/vm0.yaml"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for mock Claude echo JSONL"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: $SHARED_VOLUME_NAME
    version: latest
EOF
    $VM0_CLI compose "$TEST_CONFIG" >/dev/null
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
    if [ -n "$SHARED_VOLUME_DIR" ] && [ -d "$SHARED_VOLUME_DIR" ]; then
        rm -rf "$SHARED_VOLUME_DIR"
    fi
}

@test "t58-1: mock Claude echoes supplied JSONL stream" {
    local session_id="echo-jsonl-$(date +%s%3N)-$RANDOM"
    local prompt
    prompt=$(cat <<EOF
@ECHO@
{"type":"system","subtype":"init","cwd":"/home/user/workspace","session_id":"$session_id","tools":["Bash"],"model":"mock-claude"}
{"type":"assistant","session_id":"$session_id","message":{"role":"assistant","content":[{"type":"text","text":"echo-jsonl fixture response"}]}}
{"type":"result","subtype":"success","session_id":"$session_id","is_error":false,"duration_ms":100,"num_turns":1,"result":"Done.","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}
EOF
)

    run $VM0_CLI run "$AGENT_NAME" --verbose "$prompt"

    assert_success
    assert_output --partial "▷ Claude Code Started"
    assert_output --partial "echo-jsonl fixture response"
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "Checkpoint:"
    assert_output --partial "Session:"
}
