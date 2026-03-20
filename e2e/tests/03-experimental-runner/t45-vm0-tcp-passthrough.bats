#!/usr/bin/env bats

# Test that non-HTTP TCP traffic passes through mitmproxy correctly.
# All outbound TCP from sandbox VMs is redirected through mitmproxy.
# mitmproxy transparent mode handles non-HTTP as raw TCP passthrough.
# This test verifies raw TCP connections (SSH) work end-to-end.

load '../../helpers/setup'

setup() {
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-tcp-$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-tcp-art-$(date +%s%3N)-$RANDOM"
}

teardown() {
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

@test "non-http tcp passes through mitmproxy" {
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for TCP passthrough"
    framework: claude-code
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    # Two raw TCP connections to read SSH banners:
    # 1. github.com:22 — SSH on standard port, non-HTTP protocol
    # 2. ssh.github.com:443 — SSH on port 443 (previously intercepted as HTTPS)
    # Both must pass through mitmproxy as raw TCP without corruption.
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo PORT22=\$(timeout 5 bash -c 'head -1 < /dev/tcp/github.com/22') && echo PORT443=\$(timeout 5 bash -c 'head -1 < /dev/tcp/ssh.github.com/443')"
    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "PORT22=SSH-2.0"
    assert_output --partial "PORT443=SSH-2.0"

    # Verify TCP connections appear in network logs
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    run $CLI_COMMAND logs "$RUN_ID" --network --tail 100
    assert_success
    # TCP connections show as IP:port (DNS resolved before TCP layer)
    assert_output --partial "TCP"
    assert_output --partial ":22"
    assert_output --partial ":443"
}
