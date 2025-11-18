#!/usr/bin/env bats

load '../../helpers/setup'

# Integration test: Full workflow from create to run
# Note: These tests require a running VM0 API server with valid credentials

setup() {
    TEST_CONFIG="${TEST_ROOT}/fixtures/configs/test-agent.yaml"
}

@test "full workflow: create agent config and run it" {
    # Step 1: Create agent config
    run $CLI_COMMAND create "$TEST_CONFIG" --json
    assert_success

    # Extract agent config ID from JSON output
    agent_config_id=$(echo "$output" | grep -o '"agentConfigId":"[^"]*"' | cut -d'"' -f4)

    # Verify we got a config ID
    [ -n "$agent_config_id" ]
    [[ "$agent_config_id" =~ ^cfg- ]]

    # Step 2: Run the agent with a simple prompt
    run $CLI_COMMAND run "$agent_config_id" "echo 'Hello World'"
    assert_success
    assert_output --partial "Runtime created:"
    assert_output --partial "Output:"
    assert_output --partial "Hello World"
}

@test "workflow with dynamic vars: create and run with variable substitution" {

    # Step 1: Create agent config
    run $CLI_COMMAND create "$TEST_CONFIG" --json
    assert_success

    agent_config_id=$(echo "$output" | grep -o '"agentConfigId":"[^"]*"' | cut -d'"' -f4)
    [ -n "$agent_config_id" ]

    # Step 2: Run with dynamic variables
    run $CLI_COMMAND run "$agent_config_id" "echo 'Hello {{userName}}'" --dynamicVars '{"userName":"Alice"}'
    assert_success
    assert_output --partial "Hello Alice"
}

@test "workflow with JSON output: create and run with machine-readable output" {

    # Create config
    run $CLI_COMMAND create "$TEST_CONFIG" --json
    assert_success

    agent_config_id=$(echo "$output" | grep -o '"agentConfigId":"[^"]*"' | cut -d'"' -f4)

    # Run with JSON output
    run $CLI_COMMAND run "$agent_config_id" "echo 'test'" --json
    assert_success

    # Verify JSON structure
    assert_output --regexp '\{"runtimeId":"rt-'
    assert_output --regexp '"status":"(completed|running)"'
    assert_output --regexp '"sandboxId":"sb-'
}

@test "error handling: run with non-existent agent config" {

    run $CLI_COMMAND run cfg-nonexistent-12345 "test prompt"
    assert_failure
    assert_output --partial "404"
    assert_output --partial "Agent config not found"
}

@test "error handling: create with missing required fields" {
    # Create temporary config with missing fields
    TEMP_FILE="$(mktemp)"
    cat > "$TEMP_FILE" << EOF
version: "1.0"
agent:
  description: "Test agent"
  # Missing required fields: image, provider, working_dir, volumes
EOF

    run $CLI_COMMAND create "$TEMP_FILE"

    rm "$TEMP_FILE"

    assert_failure
    assert_output --partial "validation failed"
}

@test "stress test: create multiple configs sequentially" {

    # Create 3 agent configs
    for i in 1 2 3; do
        run $CLI_COMMAND create "$TEST_CONFIG" --json
        assert_success
        assert_output --regexp '"agentConfigId":"cfg-[a-z0-9]+"'
    done
}
