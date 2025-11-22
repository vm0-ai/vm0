#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-test-checkpoint-resume.yaml"
}

@test "Build checkpoint resume test agent configuration" {
    run $CLI_COMMAND build "$TEST_CONFIG"
    assert_success
    assert_output --partial "vm0-checkpoint-resume-test"
}

@test "Execute initial run, resume from checkpoint, and verify git volume access" {
    # Step 1: Run initial task that creates a checkpoint
    echo "# Step 1: Running initial task 'answer my question'..."
    run $CLI_COMMAND run vm0-checkpoint-resume-test -e user=lancy "answer my question"
    assert_success

    # Verify we got a checkpoint created
    assert_output --partial "Checkpoint:"

    # Extract checkpoint ID from output (format: Checkpoint: <uuid>)
    CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)

    echo "# Extracted checkpoint ID: $CHECKPOINT_ID"
    [ -n "$CHECKPOINT_ID" ] || {
        echo "# Failed to extract checkpoint ID from output:"
        echo "$output"
        return 1
    }

    # Step 2: Resume from checkpoint with new prompt
    echo "# Step 2: Resuming from checkpoint with prompt 'List all files in the current directory'..."
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" "List all files in the current directory"
    assert_success

    # Verify the run started and resumed from checkpoint
    assert_output --partial "[vm0_start]"

    # Step 3: Verify git volume is accessible and answer.md exists
    echo "# Step 3: Verifying git volume access..."
    # The agent should be able to see answer.md from the question.git repository
    assert_output --partial "answer.md"
}
