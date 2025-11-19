#!/usr/bin/env bats

load '../../helpers/setup'

# Test configuration
export TEST_CONFIG_DIR="${HOME}/.vm0-test"
export TEST_CONFIG_FILE="${TEST_CONFIG_DIR}/config.json"
export TEST_AGENT_CONFIG="${TEST_ROOT}/tests/02-first-time-user/fixtures/test-config.yaml"

# Setup: ensure clean state before each test
setup() {
    # Remove test config directory if it exists
    if [ -d "$TEST_CONFIG_DIR" ]; then
        rm -rf "$TEST_CONFIG_DIR"
    fi
}

# Teardown: cleanup after each test
teardown() {
    # Remove test config directory
    if [ -d "$TEST_CONFIG_DIR" ]; then
        rm -rf "$TEST_CONFIG_DIR"
    fi
}

# Helper: save test token to config
save_test_token() {
    local token="$1"
    local api_url="${TEST_API_URL:-http://localhost:3000}"

    mkdir -p "$TEST_CONFIG_DIR"
    cat > "$TEST_CONFIG_FILE" <<EOF
{
  "token": "$token",
  "apiUrl": "$api_url"
}
EOF
}

@test "auth status shows not authenticated initially" {
    export VM0_CONFIG_DIR="$TEST_CONFIG_DIR"
    run $CLI_COMMAND auth status
    assert_success
    assert_output --partial "Not authenticated"
}

@test "auth status shows authenticated with token" {
    skip "Requires TEST_TOKEN environment variable"

    if [ -z "$TEST_TOKEN" ]; then
        skip "TEST_TOKEN not set"
    fi

    export VM0_CONFIG_DIR="$TEST_CONFIG_DIR"
    save_test_token "$TEST_TOKEN"

    run $CLI_COMMAND auth status
    assert_success
    assert_output --partial "Authenticated"
}

@test "auth status persists token across commands" {
    skip "Requires TEST_TOKEN environment variable"

    if [ -z "$TEST_TOKEN" ]; then
        skip "TEST_TOKEN not set"
    fi

    export VM0_CONFIG_DIR="$TEST_CONFIG_DIR"
    save_test_token "$TEST_TOKEN"

    # First check
    run $CLI_COMMAND auth status
    assert_success
    assert_output --partial "Authenticated"

    # Second check (token should still be there)
    run $CLI_COMMAND auth status
    assert_success
    assert_output --partial "Authenticated"
}

@test "build command creates config successfully" {
    skip "Requires TEST_TOKEN environment variable"

    if [ -z "$TEST_TOKEN" ]; then
        skip "TEST_TOKEN not set"
    fi

    export VM0_CONFIG_DIR="$TEST_CONFIG_DIR"
    save_test_token "$TEST_TOKEN"

    run $CLI_COMMAND build "$TEST_AGENT_CONFIG"
    assert_success
    assert_output --partial "Config created"
    assert_output --partial "test-agent-e2e"
    assert_output --partial "Config ID:"
}

@test "build command shows usage instructions" {
    skip "Requires TEST_TOKEN environment variable"

    if [ -z "$TEST_TOKEN" ]; then
        skip "TEST_TOKEN not set"
    fi

    export VM0_CONFIG_DIR="$TEST_CONFIG_DIR"
    save_test_token "$TEST_TOKEN"

    run $CLI_COMMAND build "$TEST_AGENT_CONFIG"
    assert_success
    assert_output --partial "Run your agent:"
    assert_output --partial "vm0 run test-agent-e2e"
}

@test "build command fails without authentication" {
    export VM0_CONFIG_DIR="$TEST_CONFIG_DIR"

    run $CLI_COMMAND build "$TEST_AGENT_CONFIG"
    assert_failure
    # Should fail due to missing authentication or API configuration
    [[ "$output" == *"Not authenticated"* || "$output" == *"API URL not configured"* ]]
}

@test "run command works with agent name" {
    skip "Requires TEST_TOKEN environment variable and E2B execution"

    if [ -z "$TEST_TOKEN" ]; then
        skip "TEST_TOKEN not set"
    fi

    export VM0_CONFIG_DIR="$TEST_CONFIG_DIR"
    save_test_token "$TEST_TOKEN"

    # First build the config
    run $CLI_COMMAND build "$TEST_AGENT_CONFIG"
    assert_success

    # Run agent with name
    run $CLI_COMMAND run test-agent-e2e "1+1=?"
    assert_success
    assert_output --partial "Run completed"
}

@test "run command works with configId" {
    skip "Requires TEST_TOKEN environment variable and E2B execution"

    if [ -z "$TEST_TOKEN" ]; then
        skip "TEST_TOKEN not set"
    fi

    export VM0_CONFIG_DIR="$TEST_CONFIG_DIR"
    save_test_token "$TEST_TOKEN"

    # First build the config and extract configId
    output=$($CLI_COMMAND build "$TEST_AGENT_CONFIG" 2>&1)
    config_id=$(echo "$output" | grep -oP 'Config ID:\s+\K[a-f0-9-]+')

    # Run agent with configId
    run $CLI_COMMAND run "$config_id" "2+2=?"
    assert_success
    assert_output --partial "Run completed"
}

@test "run command fails without authentication" {
    export VM0_CONFIG_DIR="$TEST_CONFIG_DIR"

    run $CLI_COMMAND run test-agent "test prompt"
    assert_failure
    # Should fail due to missing authentication or agent not found
    [[ "$output" == *"Not authenticated"* || "$output" == *"Agent not found"* || "$output" == *"API URL not configured"* ]]
}

@test "logout command removes credentials" {
    skip "Requires TEST_TOKEN environment variable"

    if [ -z "$TEST_TOKEN" ]; then
        skip "TEST_TOKEN not set"
    fi

    export VM0_CONFIG_DIR="$TEST_CONFIG_DIR"
    save_test_token "$TEST_TOKEN"

    # Logout
    run $CLI_COMMAND auth logout
    assert_success
    assert_output --partial "logged out"
}

@test "auth status shows not authenticated after logout" {
    skip "Requires TEST_TOKEN environment variable"

    if [ -z "$TEST_TOKEN" ]; then
        skip "TEST_TOKEN not set"
    fi

    export VM0_CONFIG_DIR="$TEST_CONFIG_DIR"
    save_test_token "$TEST_TOKEN"

    # Logout
    $CLI_COMMAND auth logout

    # Check status
    run $CLI_COMMAND auth status
    assert_success
    assert_output --partial "Not authenticated"
}

@test "logout removes token from filesystem" {
    skip "Requires TEST_TOKEN environment variable"

    if [ -z "$TEST_TOKEN" ]; then
        skip "TEST_TOKEN not set"
    fi

    export VM0_CONFIG_DIR="$TEST_CONFIG_DIR"
    save_test_token "$TEST_TOKEN"

    # Logout
    $CLI_COMMAND auth logout

    # Verify token file removed
    [ ! -f "$TEST_CONFIG_FILE" ]
}
