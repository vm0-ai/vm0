#!/usr/bin/env bats

# Test VM0 conversation ID and fork functionality
# This test verifies that:
# 1. Run completion output includes conversationId
# 2. --conversation flag can fork from a specific conversation
# 3. Fork maintains conversation history while allowing different artifact version
#
# All tests are self-contained and can run in parallel.

load '../../helpers/setup'

setup_file() {
    # Unique agent name for this test file - must be generated in setup_file()
    # and exported to persist across test cases
    export AGENT_NAME="e2e-t08-$(date +%s%3N)-$RANDOM"
    # Create shared test directory for this file
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    # Create unique volume for this test file
    export VOLUME_NAME="e2e-vol-t08-$(date +%s%3N)-$RANDOM"
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
    description: "E2E test agent for conversation fork testing"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $VOLUME_NAME
    version: latest
EOF

    # Compose agent once for all tests in this file
    $VM0_CLI compose "$TEST_CONFIG" >/dev/null
}

setup() {
    # Per-test setup: create unique artifact name
    export ARTIFACT_NAME="e2e-conversation-$(date +%s%3N)-$RANDOM"
    export TEST_ARTIFACT_DIR="$TEST_DIR/artifacts"
    mkdir -p "$TEST_ARTIFACT_DIR"
}

teardown_file() {
    # Clean up shared test directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "t08-1: build agent configuration" {
    run $VM0_CLI compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "t08-2: run output includes conversationId" {
    # This test verifies that run completion output includes conversationId
    # Single vm0 run - safe for 30s timeout

    # Step 1: Create artifact
    echo "# Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "test-content" > file.txt
    run $VM0_CLI artifact push
    assert_success

    # Step 2: Run agent (~15s)
    echo "# Running agent..."
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo 'hello world'"

    assert_success
    assert_output --partial "Run completed successfully"
    assert_output --partial "Checkpoint:"
    assert_output --partial "Session:"

    # Verify conversationId is displayed
    assert_output --partial "Conversation:"

    # Extract conversation ID
    CONVERSATION_ID=$(echo "$output" | grep -oP 'Conversation:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Conversation ID: $CONVERSATION_ID"
    [ -n "$CONVERSATION_ID" ] || {
        echo "# Failed to extract conversation ID from output"
        echo "$output"
        return 1
    }

    echo "# Verified: conversationId is present in output"
}

@test "t08-3: fork from conversation uses new artifact version" {
    # Self-contained test: creates conversation, pushes new artifact, forks
    # 2 vm0 run calls (~15s each) + artifact push = ~35s, within 60s timeout

    # Step 1: Create artifact with initial content
    echo "# Creating initial artifact..."
    local artifact_dir="$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    mkdir -p "$artifact_dir"
    cd "$artifact_dir"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "v1" > version.txt
    echo "100" > counter.txt
    run $VM0_CLI artifact push
    assert_success

    # Step 2: Run agent to create initial conversation (~15s)
    echo "# Running agent to create conversation..."
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo 'original run' && cat version.txt && echo 200 > counter.txt"

    assert_success
    assert_output --partial "Conversation:"

    # Extract conversation ID
    local conversation_id
    conversation_id=$(echo "$output" | grep -oP 'Conversation:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Conversation ID: $conversation_id"
    [ -n "$conversation_id" ] || {
        echo "# Failed to extract conversation ID"
        echo "$output"
        return 1
    }

    # Step 3: Push new artifact version
    echo "# Pushing new artifact version..."
    cd "$artifact_dir"
    echo "v2" > version.txt
    echo "999" > counter.txt
    echo "new-file" > new.txt
    run $VM0_CLI artifact push
    assert_success
    echo "# New artifact version pushed"

    # Step 4: Fork from conversation with NEW artifact version (~15s)
    # This is the key test: --conversation lets us continue conversation history
    # but with a different (newer) artifact version
    echo "# Forking from conversation with new artifact..."
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        --conversation "$conversation_id" \
        --verbose \
        "cat version.txt && cat counter.txt && ls"

    assert_success
    assert_output --partial "● Bash("

    # Should see v2 (from new artifact), not v1 (from original conversation)
    assert_output --partial "v2"

    # Should see 999 (from new artifact), not 200 (from agent's modification)
    assert_output --partial "999"

    # Should see new.txt (only exists in new artifact version)
    assert_output --partial "new.txt"

    # Fork should create its own checkpoint/session/conversation
    assert_output --partial "Run completed successfully"
    assert_output --partial "Checkpoint:"
    assert_output --partial "Session:"
    assert_output --partial "Conversation:"

    # Extract conversation ID from fork run
    local fork_conversation_id
    fork_conversation_id=$(echo "$output" | grep -oP 'Conversation:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Fork conversation ID: $fork_conversation_id"
    [ -n "$fork_conversation_id" ]

    # Note: When using same agent config + artifact, system reuses the session
    # and may return same conversation ID. This is expected behavior.
    # The key test is that fork uses the NEW artifact version, which we verified above.

    echo "# Verified: Fork uses new artifact version with conversation context"
}
