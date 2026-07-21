#!/usr/bin/env bats

# Test network traffic logging from sandbox VMs.
#
# TCP: Outbound non-DNS TCP is redirected through mitmproxy (transparent mode).
#      Non-HTTP TCP (e.g. SSH) passes through as raw TCP.
# DNS: UDP/TCP 53 is redirected to dnsmasq and logged as type "dns".
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

    run seed_compose_fixture "$TEST_DIR/vm0.yaml"
    assert_success

    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    run seed_storage_fixture artifact "$ARTIFACT_NAME" .
    assert_success
}

@test "t45-0: non-http tcp passes through mitmproxy" {
    create_agent

    # Two raw TCP connections to read SSH banners:
    # 1. github.com:22 — SSH on standard port, non-HTTP protocol
    # 2. ssh.github.com:443 — SSH on port 443 (previously intercepted as HTTPS)
    # Both must pass through mitmproxy as raw TCP without corruption.
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
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

@test "t45-1: udp and tcp dns queries logged via dnsmasq" {
    create_agent

    # getent exercises standard UDP DNS. The Python query forces DNS over TCP
    # to a TEST-NET destination with no resolver, so a valid response proves
    # the packet was transparently redirected to dnsmasq rather than passed
    # through as generic TCP.
    local tcp_dns_script="import socket,struct; q=bytes.fromhex('123401000001000000000000077463702d646e7307696e76616c69640000010001'); s=socket.create_connection(('192.0.2.1',53),5); s.sendall(struct.pack('!H',len(q))+q); f=s.makefile('rb'); h=f.read(2); assert len(h)==2; n=struct.unpack('!H',h)[0]; r=f.read(n); assert len(r)==n and r[:2]==q[:2] and r[2]&128; print('TCP_DNS_OK=true')"
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "getent hosts example.com >/dev/null && python3 -c \"$tcp_dns_script\""
    assert_success
    assert_output --partial "TCP_DNS_OK=true"

    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    # The distinct TCP-only name proves dnsmasq parsed and logged the TCP query,
    # rather than mitmproxy recording only generic connection metadata.
    wait_for_log "$RUN_ID" --network -- \
        "example.com" \
        "tcp-dns.invalid" \
        "DNS" \
        ":53"
}

@test "t45-2: non-dns udp appears in network logs" {
    create_agent

    # Send a UDP packet to a non-DNS port (port 9999) to verify that
    # non-DNS UDP traffic is still logged via iptables LOG + /dev/kmsg.
    # DNS (UDP 53) is redirected to dnsmasq, but other UDP goes through FORWARD.
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
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
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
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

@test "t45-4: connector diagnostic fields appear in network logs" {
    create_agent

    # Since this run does not configure the replicate connector, mitmproxy
    # returns a local failed-dependency diagnostic without calling upstream and
    # persists the diagnostic metadata to network logs.
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "STATUS=\$(curl -sS -o /tmp/replicate-diagnostic.json -w '%{http_code}' https://api.replicate.com/v1/models); cat /tmp/replicate-diagnostic.json; echo; echo REPLICATE_STATUS=\$STATUS"
    assert_success
    assert_output --partial "connector_not_configured_for_run"
    assert_output --partial "REPLICATE_STATUS=424"

    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    wait_for_log "$RUN_ID" --network -- \
        "connector diagnostic" \
        "replicate" \
        "not_configured_for_run" \
        "REPLICATE_TOKEN" \
        "https://api.replicate.com"
}
