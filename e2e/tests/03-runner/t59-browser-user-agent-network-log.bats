#!/usr/bin/env bats

# Verify browser User-Agent classification is visible through the runner
# network log pipeline and CLI renderer.

load '../../helpers/setup'

setup_file() {
    export AGENT_NAME="e2e-browser-ua-netlog-$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Browser User-Agent network log marker test"
    framework: claude-code
EOF

    seed_compose_fixture "$TEST_CONFIG" >/dev/null
}

teardown_file() {
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

@test "t59-0: browser User-Agent marker appears in network logs" {
    run run_compose_fixture "$AGENT_NAME" \
        "Run the exact Bash command below, wait for it to finish, and include its output:
curl -sS -o /dev/null -w 'BROWSER_STATUS=%{http_code}\n' -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' https://example.com"

    assert_success
    assert_output --partial "BROWSER_STATUS=200"

    RUN_ID=$(run_fixture_field "$output" '.runId')
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    wait_for_log "$RUN_ID" --network -- "example.com" "[browser]"
}
