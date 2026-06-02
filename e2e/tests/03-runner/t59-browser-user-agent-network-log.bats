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

    $VM0_CLI compose "$TEST_CONFIG" >/dev/null
}

teardown_file() {
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

@test "t59-0: browser User-Agent marker appears in network logs" {
    run $VM0_CLI run "$AGENT_NAME" \
        "curl -sS -o /dev/null -w 'BROWSER_STATUS=%{http_code}\n' -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' https://example.com"

    assert_success
    assert_output --partial "Run completed successfully"
    assert_output --partial "BROWSER_STATUS=200"

    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    wait_for_log "$RUN_ID" --network -- "example.com" "[browser]"
}
