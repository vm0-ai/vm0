#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    # Backup existing cook state if any
    export COOK_STATE_BACKUP=""
    if [ -f "$HOME/.vm0/cook.json" ]; then
        COOK_STATE_BACKUP="$(cat "$HOME/.vm0/cook.json")"
    fi
    # Clear cook state for clean tests
    rm -f "$HOME/.vm0/cook.json"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
    # Restore cook state if backed up
    if [ -n "$COOK_STATE_BACKUP" ]; then
        echo "$COOK_STATE_BACKUP" > "$HOME/.vm0/cook.json"
    else
        rm -f "$HOME/.vm0/cook.json"
    fi
}

@test "cook logs fails gracefully without prior run" {
    # Ensure no cook state exists
    rm -f "$HOME/.vm0/cook.json"

    run $CLI_COMMAND cook logs
    assert_failure
    assert_output --partial "No previous run found"
    assert_output --partial "Run 'vm0 cook <prompt>' first"
}

@test "cook continue fails gracefully without prior run" {
    # Ensure no cook state exists
    rm -f "$HOME/.vm0/cook.json"

    run $CLI_COMMAND cook continue "test prompt"
    assert_failure
    assert_output --partial "No previous session found"
    assert_output --partial "Run 'vm0 cook <prompt>' first"
}

@test "cook resume fails gracefully without prior run" {
    # Ensure no cook state exists
    rm -f "$HOME/.vm0/cook.json"

    run $CLI_COMMAND cook resume "test prompt"
    assert_failure
    assert_output --partial "No previous checkpoint found"
    assert_output --partial "Run 'vm0 cook <prompt>' first"
}

@test "cook logs shows tutorial-style command hint" {
    # Create a mock cook state with a run ID
    mkdir -p "$HOME/.vm0"
    echo '{"lastRunId": "test-run-id-12345678-1234-1234-1234-123456789012"}' > "$HOME/.vm0/cook.json"

    # This will fail because the run ID doesn't exist, but we can check the command hint
    run $CLI_COMMAND cook logs
    # The command should show the tutorial-style output before failing
    assert_output --partial "> vm0 logs test-run-id-12345678-1234-1234-1234-123456789012"
}

@test "cook continue shows tutorial-style command hint" {
    # Create a mock cook state with a session ID
    mkdir -p "$HOME/.vm0"
    echo '{"lastSessionId": "test-session-12345678-1234-1234-1234-123456789012"}' > "$HOME/.vm0/cook.json"

    # This will fail because the session ID doesn't exist, but we can check the command hint
    run $CLI_COMMAND cook continue "test prompt"
    # The command should show the tutorial-style output before failing
    assert_output --partial "> vm0 run continue test-session-12345678-1234-1234-1234-123456789012"
}

@test "cook resume shows tutorial-style command hint" {
    # Create a mock cook state with a checkpoint ID
    mkdir -p "$HOME/.vm0"
    echo '{"lastCheckpointId": "test-checkpoint-1234-1234-1234-1234-123456789012"}' > "$HOME/.vm0/cook.json"

    # This will fail because the checkpoint ID doesn't exist, but we can check the command hint
    run $CLI_COMMAND cook resume "test prompt"
    # The command should show the tutorial-style output before failing
    assert_output --partial "> vm0 run resume test-checkpoint-1234-1234-1234-1234-123456789012"
}

@test "cook subcommands help is available" {
    run $CLI_COMMAND cook --help
    assert_success
    assert_output --partial "logs"
    assert_output --partial "continue"
    assert_output --partial "resume"
    assert_output --partial "View logs from the last cook run"
    assert_output --partial "Continue from the last session"
    assert_output --partial "Resume from the last checkpoint"
}

@test "cook logs supports vm0 logs options" {
    run $CLI_COMMAND cook logs --help
    assert_success
    assert_output --partial "--agent"
    assert_output --partial "--system"
    assert_output --partial "--metrics"
    assert_output --partial "--network"
    assert_output --partial "--since"
    assert_output --partial "--limit"
}
