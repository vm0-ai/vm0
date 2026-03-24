#!/usr/bin/env bats

# Test network traffic logging from sandbox VMs.
#
# TCP: All outbound TCP is redirected through mitmproxy (transparent mode).
#      Non-HTTP TCP (e.g. SSH) passes through as raw TCP.
# Non-TCP: Logged via iptables LOG + /dev/kmsg (UDP, ICMP, etc).
# Both types are written to the same per-run network JSONL file.

load '../../helpers/setup'

setup() {
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-netlog-$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-netlog-art-$(date +%s%3N)-$RANDOM"
}

teardown() {
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

# Helper: create agent and artifact for this test file
create_agent() {
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent for network logging"
    framework: claude-code
EOF

    run $VM0_CLI compose "$TEST_DIR/vm0.yaml"
    assert_success

    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $VM0_CLI artifact push
    assert_success
}

@test "t45-0: non-http tcp passes through mitmproxy" {
    create_agent

    # Two raw TCP connections to read SSH banners:
    # 1. github.com:22 — SSH on standard port, non-HTTP protocol
    # 2. ssh.github.com:443 — SSH on port 443 (previously intercepted as HTTPS)
    # Both must pass through mitmproxy as raw TCP without corruption.
    run $VM0_CLI run "$AGENT_NAME" \
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

    run $VM0_CLI logs "$RUN_ID" --network --tail 100
    assert_success
    # TCP connections show as IP:port (DNS resolved before TCP layer)
    assert_output --partial "TCP"
    assert_output --partial ":22"
    assert_output --partial ":443"
}

@test "t45-1: udp dns queries appear in network logs" {
    create_agent

    # Run a command that triggers both UDP and HTTP (TCP) traffic.
    # python3 sends a raw UDP DNS query to 8.8.8.8:53; curl makes an HTTP request.
    # Both should appear in the same network log file.
    # Note: dig/nslookup are not available in the sandbox image.
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "python3 -c \"import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.sendto(b'\\x00\\x01\\x01\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x07example\\x03com\\x00\\x00\\x01\\x00\\x01',('8.8.8.8',53)); s.recv(512); s.close(); print('UDP_OK=true')\" && curl -s -o /dev/null -w 'HTTP=%{http_code}' https://example.com"
    assert_success
    assert_output --partial "UDP_OK=true"
    assert_output --partial "HTTP=200"

    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    # Verify network logs contain the HTTP request (proves log pipeline works).
    run $VM0_CLI logs "$RUN_ID" --network --all
    assert_success
    assert_output --partial "example.com"

    # Verify network logs also contain UDP entries from DNS queries.
    # formatNetworkOther renders: [timestamp] UDP   <size> <host>:<port>
    # DNS uses port 53, so match both the protocol and port.
    assert_output --partial "UDP"
    assert_output --partial ":53"
}
