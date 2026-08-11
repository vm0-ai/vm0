#!/usr/bin/env bats

load '../../helpers/setup'
load '../../helpers/runner-chat'
load '../../helpers/runner-api'

setup() {
    runner_e2e_require_environment
    runner_e2e_setup_test
}

teardown() {
    runner_e2e_teardown_test
}

@test "runner publishes protocol, diagnostic, browser, and captured-body network telemetry" {
    run create_runner_agent "runner-network-telemetry-${TEST_ID}"
    echo "$output"
    assert_success
    AGENT_ID="$output"

    local prompt
    prompt=$(cat <<'EOF'
python3 - <<'PY'
import socket
import struct


def dns_query(transaction_id, name):
    labels = b"".join(bytes([len(label)]) + label.encode() for label in name.split("."))
    return struct.pack("!HHHHHH", transaction_id, 0x0100, 1, 0, 0, 0) + labels + b"\x00\x00\x01\x00\x01"


def read_exact(connection, size):
    data = bytearray()
    while len(data) < size:
        chunk = connection.recv(size - len(data))
        if not chunk:
            raise RuntimeError("DNS connection closed before the response completed")
        data.extend(chunk)
    return bytes(data)


try:
    with socket.create_connection(("192.0.2.1", 4444), timeout=3) as connection:
        connection.sendall(b"vm0-raw-tcp-probe")
except OSError:
    pass
print("RAW_TCP_PROBE_DONE")

with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
    connection.sendto(b"vm0-udp-probe", ("192.0.2.1", 9999))
print("UDP_PROBE_DONE")

udp_query = dns_query(0x4501, "udp-dns.invalid")
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
    connection.settimeout(5)
    connection.sendto(udp_query, ("192.0.2.1", 53))
    udp_response, _ = connection.recvfrom(4096)
assert udp_response[:2] == udp_query[:2] and udp_response[2] & 0x80
print("UDP_DNS_PROBE_DONE")

tcp_query = dns_query(0x4502, "tcp-dns.invalid")
with socket.create_connection(("192.0.2.1", 53), timeout=5) as connection:
    connection.sendall(struct.pack("!H", len(tcp_query)) + tcp_query)
    response_size = struct.unpack("!H", read_exact(connection, 2))[0]
    tcp_response = read_exact(connection, response_size)
assert tcp_response[:2] == tcp_query[:2] and tcp_response[2] & 0x80
print("TCP_DNS_PROBE_DONE")
PY

replicate_status=$(curl --silent --show-error --max-time 10 \
    --output /tmp/replicate-diagnostic.json \
    --write-out '%{http_code}' \
    https://api.replicate.com/v1/models || true)
cat /tmp/replicate-diagnostic.json 2>/dev/null || true
printf '\nREPLICATE_STATUS=%s\n' "$replicate_status"

curl --silent --show-error --max-time 10 \
    --request GET \
    --user-agent 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' \
    --header 'Content-Type: text/plain' \
    --data 'vm0-captured-request-body' \
    --output /tmp/browser-response.txt \
    https://www.google.com/ || true
printf 'BROWSER_REQUEST_DONE\n'
printf 'NETWORK_PROBES_DONE\n'
EOF
)
    run runner_e2e_start_chat_run "$AGENT_ID" "$prompt" true
    echo "$output"
    assert_success
    RUN_ID=$(jq -er '.runId | select(type == "string" and length > 0)' <<<"$output")
    THREAD_ID=$(jq -er '.threadId' <<<"$output")

    run runner_wait_for_run "$RUN_ID" 150
    echo "$output"
    assert_success

    run runner_e2e_wait_for_agent_text "$RUN_ID" NETWORK_PROBES_DONE 30
    echo "$output"
    assert_success
    assert_output --partial "RAW_TCP_PROBE_DONE"
    assert_output --partial "UDP_PROBE_DONE"
    assert_output --partial "UDP_DNS_PROBE_DONE"
    assert_output --partial "TCP_DNS_PROBE_DONE"
    assert_output --partial "REPLICATE_STATUS=424"
    assert_output --partial "BROWSER_REQUEST_DONE"

    local network_logs='[]'
    local telemetry_found=false
    local started_at=$SECONDS
    while ((SECONDS - started_at < 60)); do
        if network_logs=$(runner_e2e_network_logs "$RUN_ID" 2>&1) &&
            jq -e '
                any(.[];
                    .type == "tcp" and
                    .host == "192.0.2.1" and
                    .port == 4444) and
                any(.[];
                    .type == "udp" and
                    .host == "192.0.2.1" and
                    .port == 9999) and
                any(.[];
                    .type == "dns" and
                    .host == "udp-dns.invalid" and
                    .port == 53 and
                    .dns_event == "query") and
                any(.[];
                    .type == "dns" and
                    .host == "tcp-dns.invalid" and
                    .port == 53 and
                    .dns_event == "query") and
                any(.[];
                    .type == "http" and
                    .host == "api.replicate.com" and
                    .status == 424 and
                    .connector_diagnostic_slug == "replicate" and
                    .connector_diagnostic_reason == "not_configured_for_run" and
                    .connector_diagnostic_env_names == ["REPLICATE_TOKEN"] and
                    .connector_diagnostic_base == "https://api.replicate.com") and
                any(.[];
                    .type == "http" and
                    .host == "www.google.com" and
                    .browser_user_agent == true and
                    .request_body == "vm0-captured-request-body" and
                    (.response_body | type) == "string" and
                    (.response_body | length) > 0)
            ' <<<"$network_logs" >/dev/null; then
            telemetry_found=true
            break
        fi
        sleep 2
    done

    if [[ "$telemetry_found" != "true" ]]; then
        echo "Missing required network telemetry for run ${RUN_ID}" >&2
        echo "Last network telemetry: ${network_logs}" >&2
        return 1
    fi
}
