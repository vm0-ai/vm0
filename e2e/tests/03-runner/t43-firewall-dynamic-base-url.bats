#!/usr/bin/env bats

# Test firewall dynamic base URL resolution for connectors with subdomain-based APIs.
#
# Verifies the full flow for zendesk (api-token connector with ${{ vars.X }} base URL):
# 1. Set up connector via one connector-aware CLI call
# 2. Compose agent that relies on stored connector environment injection
# 3. System auto-detects zendesk as connected, adds firewall with resolved base URL
# 4. Placeholder env var injected in sandbox
# 5. Proxy matches requests to resolved base URL and injects auth header

load '../../helpers/setup'

setup_file() {
    if [[ -z "$VM0_API_URL" ]]; then
        echo "VM0_API_URL not set" >&2
        return 1
    fi

    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-zendesk-fw-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-zendesk-fw-artifact-${UNIQUE_ID}"
    export TEST_SUBDOMAIN="e2etest${RANDOM}"

    # Set up zendesk connector via real CLI — same as user doing it in web UI.
    $ZERO_CLI connector connect zendesk \
        --value ZENDESK_API_TOKEN=fake-zendesk-token-for-e2e \
        --value ZENDESK_SUBDOMAIN="$TEST_SUBDOMAIN" \
        --value ZENDESK_EMAIL=e2e@test.vm0.ai

    # Create artifact
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test" > test.txt
    $VM0_CLI artifact push >/dev/null 2>&1
    cd - >/dev/null
}

teardown_file() {
    zero_curl "/api/zero/connectors/zendesk" -X DELETE >/dev/null 2>&1 || true

    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "firewall: dynamic base URL — zendesk placeholder injection" {
    cat > "$TEST_DIR/vm0-placeholder.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-placeholder:
    description: "Zendesk dynamic base URL placeholder test"
    framework: claude-code
EOF

    run $VM0_CLI compose --yes "$TEST_DIR/vm0-placeholder.yaml"
    echo "$output"
    assert_success

    run $VM0_CLI run "${AGENT_NAME}-placeholder" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo \"TOKEN=\$ZENDESK_API_TOKEN\" && echo \"SUBDOMAIN=\$ZENDESK_SUBDOMAIN\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # Token should be the placeholder (not the real fake token)
    assert_output --partial "TOKEN=zkTkn_CoffeeSafeLocalCoffeeSafeLocalCoffeeSa"
    # Subdomain should be the real value (it's a variable, not a secret)
    assert_output --partial "SUBDOMAIN=${TEST_SUBDOMAIN}"
}

@test "firewall: dynamic base URL — zendesk proxy token replacement" {
    cat > "$TEST_DIR/vm0-proxy.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-proxy:
    description: "Zendesk dynamic base URL proxy test"
    framework: claude-code
EOF

    run $VM0_CLI compose --yes "$TEST_DIR/vm0-proxy.yaml"
    echo "$output"
    assert_success

    # Make a request to the zendesk API through the proxy.
    # If proxy matched: zendesk returns 401 (bad token) or 404 (subdomain not found)
    # If proxy blocked: returns 403 with "no matching permission" error
    run $VM0_CLI run "${AGENT_NAME}-proxy" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "STATUS=\$(curl -s -o /dev/null -w '%{http_code}' https://${TEST_SUBDOMAIN}.zendesk.com/api/v2/users/me.json) && echo \"ZENDESK_STATUS=\$STATUS\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # Verify proxy did NOT block the request (403 = firewall blocked, no match).
    # Any other status (401, 404) means proxy matched and forwarded successfully.
    refute_output --partial "ZENDESK_STATUS=403"
    assert_output --regexp "ZENDESK_STATUS=(401|404)"

    # Check network logs confirm firewall match
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    # ALLOW: proxy matched zendesk firewall and forwarded
    wait_for_log "$RUN_ID" --network -- "[zendesk]"
}
