#!/usr/bin/env bats

# Test firewall auth.query — query-parameter authentication injection.
#
# Verifies the full flow for connectors that authenticate via URL query params
# (e.g., SerpApi uses ?api_key=XXX instead of an Authorization header):
# 1. Set up connector via API-token connector flow
# 2. Compose agent with environment referencing connector secret
# 3. System detects serpapi as connected, adds firewall with auth.query
# 4. Placeholder env var injected in sandbox
# 5. Proxy matches requests and injects api_key query parameter

load '../../helpers/setup'

setup_file() {
    if [[ -z "$VM0_API_URL" ]]; then
        echo "VM0_API_URL not set" >&2
        return 1
    fi

    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-auth-query-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-auth-query-artifact-${UNIQUE_ID}"

    # Set up serpapi connector — api-token auth, single secret.
    $ZERO_CLI connector connect serpapi \
        --value SERPAPI_TOKEN=fake-serpapi-token-for-e2e

    # Create artifact
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test" > test.txt
    $VM0_CLI artifact push >/dev/null 2>&1
    cd - >/dev/null
}

teardown_file() {
    zero_curl "/api/zero/connectors/serpapi" -X DELETE >/dev/null 2>&1 || true

    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "firewall: auth.query — serpapi placeholder injection" {
    cat > "$TEST_DIR/vm0-placeholder.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-placeholder:
    description: "SerpApi auth.query placeholder test"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      SERPAPI_TOKEN: \${{ secrets.SERPAPI_TOKEN }}
EOF

    run $VM0_CLI compose --yes "$TEST_DIR/vm0-placeholder.yaml"
    echo "$output"
    assert_success

    run $VM0_CLI run "${AGENT_NAME}-placeholder" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo \"TOKEN=\$SERPAPI_TOKEN\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # Token should be the placeholder (not the real fake token)
    assert_output --partial "TOKEN=CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCof"
}

@test "firewall: auth.query — serpapi proxy query param injection" {
    cat > "$TEST_DIR/vm0-proxy.yaml" <<EOF
version: "1.0"

agents:
  ${AGENT_NAME}-proxy:
    description: "SerpApi auth.query proxy test"
    framework: claude-code
    working_dir: /home/user/workspace
    environment:
      SERPAPI_TOKEN: \${{ secrets.SERPAPI_TOKEN }}
EOF

    run $VM0_CLI compose --yes "$TEST_DIR/vm0-proxy.yaml"
    echo "$output"
    assert_success

    # Make a request to SerpApi through the proxy.
    # The proxy should inject api_key as a query parameter (auth.query).
    #
    # Key insight: SerpApi returns 200 when no api_key is present (anonymous),
    # but returns 401 when api_key IS present but invalid. So 401 is the
    # definitive proof that the proxy injected our fake api_key query param.
    # 403 = firewall blocked (proxy didn't match).
    run $VM0_CLI run "${AGENT_NAME}-proxy" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "STATUS=\$(curl -s -o /dev/null -w '%{http_code}' 'https://serpapi.com/search?q=test&engine=google') && echo \"SERPAPI_STATUS=\$STATUS\""

    echo "$output"
    assert_success
    assert_output --partial "Run completed successfully"

    # 401 proves api_key was injected (SerpApi rejects our fake token).
    # 429 also proves injection (rate-limited, but request reached SerpApi with api_key).
    # Without api_key, SerpApi returns 200 (anonymous access).
    # 403 would mean the proxy blocked the request entirely.
    refute_output --partial "SERPAPI_STATUS=200"
    refute_output --partial "SERPAPI_STATUS=403"
    assert_output --regexp "SERPAPI_STATUS=(401|429)"

    # Check network logs confirm firewall match
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        return 1
    }

    # ALLOW: proxy matched serpapi firewall and injected query param
    wait_for_log "$RUN_ID" --network -- "[serpapi]"
}
