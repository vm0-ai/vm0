#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-git-artifact.yaml"
}

@test "Build checkpoint resume test agent configuration" {
    run $CLI_COMMAND build "$TEST_CONFIG"
    assert_success
    assert_output --partial "vm0-git-artifact"
}

@test "Execute initial run, resume from checkpoint, and verify git volume access" {
    # Step 1: Run initial task that creates a checkpoint
    # Using bash command to read files from git volume (lancy/question.git contains question.md)
    echo "# Step 1: Running initial task to read files from git volume..."
    run $CLI_COMMAND run vm0-git-artifact -e user=lancy "cat question.md"
    assert_success

    # Verify mock-claude execution events (deterministic with mock-claude)
    assert_output --partial "[tool_use] Bash"
    assert_output --partial "cat question.md"
    assert_output --partial "[tool_result]"
    assert_output --partial "[result]"

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
    # Using ls command to list files in current directory
    echo "# Step 2: Resuming from checkpoint to list files..."
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" "ls -la"
    assert_success

    # Verify the run started and resumed from checkpoint
    assert_output --partial "[vm0_start]"

    # Step 3: Verify git volume is accessible and question.md exists
    echo "# Step 3: Verifying git volume access..."
    # The agent should be able to see question.md from the question.git repository
    # With mock-claude, the ls -la output is deterministic
    assert_output --partial "[tool_use] Bash"
    assert_output --partial "ls -la"
    assert_output --partial "question.md"
}
