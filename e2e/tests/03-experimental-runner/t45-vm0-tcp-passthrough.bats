#!/usr/bin/env bats

# Test that non-HTTP TCP traffic passes through mitmproxy correctly.
# All outbound TCP from sandbox VMs is redirected through mitmproxy.
# mitmproxy transparent mode handles non-HTTP as raw TCP passthrough.
# This test verifies that a raw TCP connection (SSH) works end-to-end.

load '../../helpers/setup'

setup() {
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-tcp-$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-tcp-art-$(date +%s%3N)-$RANDOM"
}

teardown() {
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

@test "non-http tcp passes through mitmproxy (ssh banner)" {
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

    # Connect to GitHub's SSH port and read the banner.
    # This is a raw TCP connection — not HTTP — so it exercises
    # mitmproxy's TCP passthrough after the all-TCP redirect.
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "timeout 5 bash -c 'cat < /dev/tcp/github.com/22 | head -1'"
    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "SSH-2.0"
}

@test "https on non-standard port works through mitmproxy" {
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for HTTPS non-standard port"
    framework: claude-code
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    # GitHub SSH service also listens on port 443 (ssh.github.com:443).
    # This is a non-standard port for SSH — previously would have been
    # intercepted as HTTPS and broken. With all-TCP redirect, mitmproxy
    # detects it's not HTTP and passes through as raw TCP.
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "timeout 5 bash -c 'cat < /dev/tcp/ssh.github.com/443 | head -1'"
    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "SSH-2.0"
}
