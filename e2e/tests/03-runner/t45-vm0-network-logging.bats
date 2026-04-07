#!/usr/bin/env bats

# Test network traffic logging from sandbox VMs.
#
# TCP: All outbound TCP is redirected through mitmproxy (transparent mode).
#      Non-HTTP TCP (e.g. SSH) passes through as raw TCP.
# DNS: Queries intercepted via iptables REDIRECT to dnsmasq, logged as type "dns".
# Non-TCP: Logged via iptables LOG + /dev/kmsg (UDP, ICMP, etc).
# All types are written to the same per-run network JSONL file.

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

    # TCP connections show as IP:port (DNS resolved before TCP layer)
    wait_for_log "$RUN_ID" --network -- "TCP" ":22" ":443"
}

@test "t45-1: dns queries logged via dnsmasq" {
    create_agent

    # DNS queries are intercepted by iptables REDIRECT to dnsmasq and logged
    # as type "dns". getent triggers a standard libc DNS lookup.
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "getent hosts example.com"
    assert_success

    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    # Verify network logs contain DNS entries.
    # DNS entries render as: [timestamp] DNS   example.com:53
    wait_for_log "$RUN_ID" --network -- "example.com" "DNS" ":53"
}

@test "t45-2: non-dns udp appears in network logs" {
    create_agent

    # Send a UDP packet to a non-DNS port (port 9999) to verify that
    # non-DNS UDP traffic is still logged via iptables LOG + /dev/kmsg.
    # DNS (UDP 53) is redirected to dnsmasq, but other UDP goes through FORWARD.
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "python3 -c \"import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.sendto(b'hello',('8.8.8.8',9999)); s.close(); print('UDP_SENT=true')\""
    assert_success
    assert_output --partial "UDP_SENT=true"

    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    # UDP entries render as: [timestamp] UDP   <size> 8.8.8.8:9999
    wait_for_log "$RUN_ID" --network -- "UDP" ":9999"
}

@test "t45-3: capture-network-bodies captures request headers and response body" {
    create_agent

    # Run with --capture-network-bodies enabled. The CLI network log renderer
    # displays request_headers and response_body when present.
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        --capture-network-bodies \
        "curl -s -o /dev/null -w '%{http_code}' https://www.vm0.ai"
    assert_success

    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    # Verify network logs contain captured fields rendered by the CLI
    wait_for_log "$RUN_ID" --network -- "request_headers:" "response_body:"
}
