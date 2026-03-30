#!/usr/bin/env bats

# Test firewall dynamic base URL resolution for connectors with subdomain-based APIs.
#
# Verifies the full flow for zendesk (api-token connector with ${{ vars.X }} base URL):
# 1. Set up connector via real CLI (secret set + variable set)
# 2. Create agent via zero agent create --connectors zendesk (auto-injects env)
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
    export TEST_SUBDOMAIN="e2etest${RANDOM}"

    # Set up zendesk connector via real CLI — same as user doing it in web UI.
    # api-token connectors are inferred from matching secrets + variables.
    $ZERO_CLI secret set ZENDESK_API_TOKEN --body "fake-zendesk-token-for-e2e"
    $ZERO_CLI variable set ZENDESK_SUBDOMAIN "$TEST_SUBDOMAIN"
    $ZERO_CLI variable set ZENDESK_EMAIL "e2e@test.vm0.ai"

    # Create agent with zendesk connector — auto-injects env vars + firewall
    local max_attempts=6
    for ((attempt=1; attempt<=max_attempts; attempt++)); do
        run $ZERO_CLI agent create --connectors zendesk
        if [[ "$status" -eq 0 ]]; then
            break
        fi
        if [[ "$output" == *"not cached"* ]] && ((attempt < max_attempts)); then
            echo "Attempt $attempt: skill cache not ready, retrying in 5s..." >&2
            sleep 5
        else
            break
        fi
    done
    if [[ "$status" -ne 0 ]]; then
        echo "Failed to create agent: $output" >&2
        return 1
    fi

    export AGENT_ID=$(echo "$output" | grep -oP 'Agent "\K[^"]+')
    if [[ -z "$AGENT_ID" ]]; then
        echo "Failed to extract agent ID from: $output" >&2
        return 1
    fi
}

teardown_file() {
    # Clean up agent
    if [ -n "$AGENT_ID" ]; then
        $ZERO_CLI agent delete "$AGENT_ID" --yes 2>/dev/null || true
    fi
    # Clean up secrets and variables
    $ZERO_CLI secret delete -y ZENDESK_API_TOKEN 2>/dev/null || true
    $ZERO_CLI variable delete -y ZENDESK_SUBDOMAIN 2>/dev/null || true
    $ZERO_CLI variable delete -y ZENDESK_EMAIL 2>/dev/null || true

    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "firewall: dynamic base URL — zendesk placeholder injection" {
    [ -n "$AGENT_ID" ] || skip "agent not created"

    # Run via zero run — env vars auto-injected by connector
    run $ZERO_CLI run "$AGENT_ID" \
        "echo \"TOKEN=\$ZENDESK_API_TOKEN\" && echo \"SUBDOMAIN=\$ZENDESK_SUBDOMAIN\""

    echo "$output"
    assert_success

    # Token should be the placeholder (not the real fake token)
    assert_output --partial "TOKEN=zkTkn_Vm0PlaceHolder"
    # Subdomain should be the real value (it's a variable, not a secret)
    assert_output --partial "SUBDOMAIN=${TEST_SUBDOMAIN}"
}

@test "firewall: dynamic base URL — zendesk proxy token replacement" {
    [ -n "$AGENT_ID" ] || skip "agent not created"

    # Make a request to the zendesk API through the proxy.
    # The proxy should:
    # 1. Match the URL against the resolved base URL (https://{subdomain}.zendesk.com)
    # 2. Replace the placeholder token with the real token in Authorization header
    # 3. Forward the request — NOT a 403 (proxy block)
    #
    # If proxy matched: zendesk returns 401 (bad token) or 404 (subdomain not found)
    # If proxy blocked: returns 403 with "no matching permission" error
    run $ZERO_CLI run "$AGENT_ID" \
        "STATUS=\$(curl -s -o /dev/null -w '%{http_code}' https://${TEST_SUBDOMAIN}.zendesk.com/api/v2/users/me.json) && echo \"ZENDESK_STATUS=\$STATUS\""

    echo "$output"
    assert_success

    # Verify proxy did NOT block the request (403 = firewall blocked, no match).
    # Any other status (401, 404) means proxy matched and forwarded successfully.
    refute_output --partial "ZENDESK_STATUS=403"
    assert_output --regexp "ZENDESK_STATUS=(401|404)"

    # Also check network logs confirm firewall match
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    run $VM0_CLI logs "$RUN_ID" --network --tail 100
    assert_success
    # ALLOW: proxy matched zendesk firewall and forwarded
    assert_output --partial "[zendesk]"
}
