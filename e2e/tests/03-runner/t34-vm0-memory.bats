#!/usr/bin/env bats

# Test VM0 memory flag persistence across continue and resume flows
# This test verifies the auto-memory direct-mount flow (post-#10602):
# 1. runner mounts memory directly at ~/.claude/projects/-{wd}/memory
#    (no guest-agent symlink bootstrap — memory rides in manifest.artifacts[])
# 2. Agent writes through that mount path (as Claude Code does in production)
# 3. vm0 run continue restores memory and the mount is recreated
# 4. vm0 run resume restores memory from checkpoint and the mount is recreated
# 5. Fresh run with same --memory name reads previously written marker (dedup path)
#
# mock-claude executes the prompt as a bash command, so we write a marker file
# through the mount path and verify it survives across continue/resume.
#
# Each test is self-contained: it runs its own initial vm0 run to create state,
# then verifies the behavior under test. Two vm0 run calls (~15s each) = ~30s,
# well within the 60s timeout.

load '../../helpers/setup'

setup_file() {
    # Unique agent name for this test file
    export AGENT_NAME="e2e-t34-$(date +%s%3N)-$RANDOM"
    # Create shared test directory for this file
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    # Create unique volume for this test file
    export VOLUME_NAME="e2e-vol-t34-$(date +%s%3N)-$RANDOM"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    cat > CLAUDE.md << 'VOLEOF'
This is a test file for the volume.
VOLEOF
    $VM0_CLI volume init --name "$VOLUME_NAME" >/dev/null
    $VM0_CLI volume push >/dev/null
    cd - >/dev/null

    # Create inline config with unique agent name
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for memory flag testing"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    # Direct-mount path (post-#10602): runner mounts memory here as a directory,
    # encoded from working_dir "/home/user/workspace" as "-home-user-workspace".
    export MEMORY_MOUNT="/home/user/.claude/projects/-home-user-workspace/memory"

    # Compose agent once for all tests in this file
    $VM0_CLI compose "$TEST_CONFIG" >/dev/null

}

teardown_file() {
    # Clean up shared test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "t34-1: build agent configuration" {
    run $VM0_CLI compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "t34-2: continue from session reads memory marker" {
    # Unique memory name per test to avoid conflicts with parallel tests
    local memory_name="e2e-mem-t34-2-$(date +%s%3N)-$RANDOM"

    # Step 1: Run agent with --memory, write marker file through mount directory
    # Verifies: memory mount exists as a directory, write-through works
    run $VM0_CLI run "$AGENT_NAME" \
        --memory "$memory_name" \
        "test -d $MEMORY_MOUNT && echo 'memory-marker-t34' > $MEMORY_MOUNT/marker.txt && cat $MEMORY_MOUNT/marker.txt"

    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "memory-marker-t34"
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "Checkpoint:"
    assert_output --partial "Session:"

    # Extract session ID
    local session_id
    session_id=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Session ID: $session_id"
    [ -n "$session_id" ] || {
        echo "# Failed to extract session ID"
        echo "$output"
        return 1
    }

    # Step 2: Continue from session, verify marker file is readable through mount
    echo "# Continuing from session: $session_id (no --memory flag)..."
    run $VM0_CLI run continue "$session_id" \
        --verbose \
        "test -d $MEMORY_MOUNT && cat $MEMORY_MOUNT/marker.txt"

    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "memory-marker-t34"
}

@test "t34-3: resume from checkpoint reads memory marker" {
    # Unique memory name per test to avoid conflicts with parallel tests
    local memory_name="e2e-mem-t34-3-$(date +%s%3N)-$RANDOM"

    # Step 1: Run agent with --memory, write marker file through mount directory
    run $VM0_CLI run "$AGENT_NAME" \
        --memory "$memory_name" \
        "test -d $MEMORY_MOUNT && echo 'memory-marker-t34' > $MEMORY_MOUNT/marker.txt && cat $MEMORY_MOUNT/marker.txt"

    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "memory-marker-t34"
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "Checkpoint:"
    assert_output --partial "Session:"

    # Extract checkpoint ID
    local checkpoint_id
    checkpoint_id=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Checkpoint ID: $checkpoint_id"
    [ -n "$checkpoint_id" ] || {
        echo "# Failed to extract checkpoint ID"
        echo "$output"
        return 1
    }

    # Step 2: Resume from checkpoint, verify marker file is readable through mount
    echo "# Resuming from checkpoint: $checkpoint_id (no --memory flag)..."
    run $VM0_CLI run resume "$checkpoint_id" \
        --verbose \
        "test -d $MEMORY_MOUNT && cat $MEMORY_MOUNT/marker.txt"

    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "memory-marker-t34"
}

@test "t34-4: fresh run with memory reads previously written marker (dedup path)" {
    # Unique memory name per test to avoid conflicts with parallel tests
    local memory_name="e2e-mem-t34-4-$(date +%s%3N)-$RANDOM"

    # Step 1: Run agent with --memory, write marker file through mount directory
    run $VM0_CLI run "$AGENT_NAME" \
        --memory "$memory_name" \
        "test -d $MEMORY_MOUNT && echo 'memory-marker-t34' > $MEMORY_MOUNT/marker.txt && cat $MEMORY_MOUNT/marker.txt"

    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "memory-marker-t34"
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "Checkpoint:"
    assert_output --partial "Session:"

    # Step 2: Fresh run with same --memory name triggers dedup path:
    # memory content is unchanged since step 1, so the prepare endpoint
    # returns existing=true and the commit must use the correct
    # storageType ("memory", not "artifact").
    echo "# Running fresh agent with --memory $memory_name (dedup path)..."
    run $VM0_CLI run "$AGENT_NAME" \
        --memory "$memory_name" \
        "test -d $MEMORY_MOUNT && cat $MEMORY_MOUNT/marker.txt"

    assert_success
    assert_output --partial "● Bash("
    assert_output --partial "memory-marker-t34"
    assert_output --partial "◆ Claude Code Completed"
    assert_output --partial "Checkpoint:"
}
