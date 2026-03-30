#!/usr/bin/env bats

# Test firewall dynamic base URL resolution for connectors with subdomain-based APIs.
#
# Verifies the full flow for zendesk (api-token connector with ${{ vars.X }} base URL):
# 1. Set up connector via real CLI (secret set + variable set)
# 2. System auto-detects zendesk as connected (deriveApiTokenConnectedTypes)
# 3. Firewall base URL template resolved with user's subdomain variable
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
    # api-token connectors are inferred from matching secrets + variables.
    $ZERO_CLI secret set ZENDESK_API_TOKEN --body "fake-zendesk-token-for-e2e"
    $ZERO_CLI variable set ZENDESK_SUBDOMAIN "$TEST_SUBDOMAIN"
    $ZERO_CLI variable set ZENDESK_EMAIL "e2e@test.vm0.ai"

    # Create artifact
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test" > test.txt
    $VM0_CLI artifact push >/dev/null 2>&1
    cd - >/dev/null
}

teardown_file() {
    # Clean up secrets and variables
    $ZERO_CLI secret delete -y ZENDESK_API_TOKEN 2>/dev/null || true
    $ZERO_CLI variable delete -y ZENDESK_SUBDOMAIN 2>/dev/null || true
    $ZERO_CLI variable delete -y ZENDESK_EMAIL 2>/dev/null || true

    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "firewall: dynamic base URL — zendesk placeholder injection" {
    # No experimental_firewalls declared — system auto-adds zendesk firewall
    # because the connector is detected as connected (all required fields present).
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-placeholder:
    description: "Zendesk dynamic base URL placeholder test"
    framework: claude-code
    working_dir: /home/user/workspace
EOF

    run $VM0_CLI compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Verify ZENDESK_API_TOKEN is replaced with firewall placeholder in sandbox
    run $VM0_CLI run "${AGENT_NAME}-placeholder" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo \"TOKEN=\$ZENDESK_API_TOKEN\" && echo \"SUBDOMAIN=\$ZENDESK_SUBDOMAIN\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # Token should be the placeholder (not the real fake token)
    assert_output --partial "TOKEN=zkTkn_Vm0PlaceHolder"
    # Subdomain should be the real value (it's a variable, not a secret)
    assert_output --partial "SUBDOMAIN=${TEST_SUBDOMAIN}"
}

@test "firewall: dynamic base URL — zendesk proxy token replacement" {
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-proxy:
    description: "Zendesk dynamic base URL proxy test"
    framework: claude-code
    working_dir: /home/user/workspace
EOF

    run $VM0_CLI compose "$TEST_DIR/vm0.yaml"
    assert_success

    # Make a request to the zendesk API through the proxy.
    # The proxy should:
    # 1. Match the URL against the resolved base URL (https://{subdomain}.zendesk.com)
    # 2. Replace the placeholder token with the real token in Authorization header
    # 3. Forward the request — zendesk returns 401 (fake token) but NOT 403 (proxy block)
    #
    # 401 = proxy matched and forwarded (auth header injected, zendesk rejected fake token)
    # 403 = proxy blocked (no firewall match — would mean base URL resolution failed)
    run $VM0_CLI run "${AGENT_NAME}-proxy" \
        --artifact-name "$ARTIFACT_NAME" \
        "STATUS=\$(curl -s -o /dev/null -w '%{http_code}' https://${TEST_SUBDOMAIN}.zendesk.com/api/v2/users/me.json) && echo \"ZENDESK_STATUS=\$STATUS\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # 401 means proxy matched the firewall, injected the auth header,
    # and zendesk rejected the fake token. This proves the dynamic base URL works.
    assert_output --partial "ZENDESK_STATUS=401"
}
