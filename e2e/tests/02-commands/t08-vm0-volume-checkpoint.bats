#!/usr/bin/env bats

# Test VM0 volume checkpoint versioning
# This test verifies that:
# 1. Agent runs create new volume versions during checkpoint
# 2. Resume from checkpoint restores the specific version from checkpoint, not HEAD

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_VOLUME_DIR="$(mktemp -d)"
    # Use unique test volume name with timestamp
    export VOLUME_NAME="e2e-checkpoint-vol-$(date +%s)"
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-test-vm0-volume-checkpoint.yaml"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_VOLUME_DIR" ] && [ -d "$TEST_VOLUME_DIR" ]; then
        rm -rf "$TEST_VOLUME_DIR"
    fi
}

@test "Build VM0 volume checkpoint test agent configuration" {
    run $CLI_COMMAND build "$TEST_CONFIG"
    assert_success
    assert_output --partial "vm0-volume-checkpoint-test"
}

@test "VM0 volume checkpoint: run creates version, resume restores it" {
    # Step 1: Create and push initial volume content
    echo "# Step 1: Creating initial volume..."
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    echo "initial content before agent" > state.txt
    run $CLI_COMMAND volume push
    assert_success

    # Step 2: Run agent to modify the volume and create checkpoint
    echo "# Step 2: Running agent to modify volume..."
    run $CLI_COMMAND run vm0-volume-checkpoint-test \
        -e volumeName="$VOLUME_NAME" \
        "Create a file called agent-marker.txt with content 'created by agent run' in the current directory"

    assert_success
    assert_output --partial "Checkpoint:"

    # Extract checkpoint ID
    CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Checkpoint ID: $CHECKPOINT_ID"
    [ -n "$CHECKPOINT_ID" ] || {
        echo "# Failed to extract checkpoint ID"
        echo "$output"
        return 1
    }

    # Step 3: Push new content to volume (simulating external changes)
    # This makes HEAD different from the checkpoint version
    echo "# Step 3: Pushing new content to make HEAD different..."
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    echo "content after checkpoint - this is HEAD" > state.txt
    echo "external marker" > external-marker.txt
    rm -f agent-marker.txt 2>/dev/null || true

    run $CLI_COMMAND volume push
    assert_success
    echo "# New HEAD version pushed"

    # Step 4: Resume from checkpoint
    echo "# Step 4: Resuming from checkpoint..."
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" \
        "List all files in the current directory and read the content of state.txt"

    assert_success

    # Step 5: Verify we got the checkpoint version, not HEAD
    echo "# Step 5: Verifying checkpoint version is restored..."

    # Should NOT see the external-marker.txt (which was added after checkpoint)
    refute_output --partial "external-marker.txt"

    # Should see agent-marker.txt (created during checkpoint run)
    assert_output --partial "agent-marker.txt"

    # The state.txt content should be from checkpoint, not "content after checkpoint"
    refute_output --partial "content after checkpoint"
}

@test "VM0 volume checkpoint preserves file modifications from agent" {
    # Setup: Create volume with initial content
    mkdir -p "$TEST_VOLUME_DIR/$VOLUME_NAME"
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init >/dev/null

    echo "100" > counter.txt
    $CLI_COMMAND volume push >/dev/null

    # Run 1: Agent increments the counter
    echo "# Running agent to modify counter..."
    run $CLI_COMMAND run vm0-volume-checkpoint-test \
        -e volumeName="$VOLUME_NAME" \
        "Read counter.txt, increment the number by 1, and write the new value back to counter.txt"

    assert_success
    CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    [ -n "$CHECKPOINT_ID" ]

    # Push external change (reset counter to 0)
    cd "$TEST_VOLUME_DIR/$VOLUME_NAME"
    echo "0" > counter.txt
    $CLI_COMMAND volume push >/dev/null

    # Resume: Should see 101 (from checkpoint), not 0 (HEAD)
    run $CLI_COMMAND run resume "$CHECKPOINT_ID" \
        "Read counter.txt and tell me the exact number"

    assert_success
    assert_output --partial "101"
    # The counter should show 101, not be reset to 0
    # Using a simpler check - verify we got 101 and didn't get a standalone "0"
    refute_output --partial "counter is 0"
    refute_output --partial "number is 0"
}
