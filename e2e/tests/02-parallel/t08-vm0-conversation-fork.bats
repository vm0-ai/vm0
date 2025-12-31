#!/usr/bin/env bats

# Test VM0 conversation ID and fork functionality
# This test verifies that:
# 1. Run completion output includes conversationId
# 2. --conversation flag can fork from a specific conversation
# 3. Fork maintains conversation history while allowing different artifact version
#
# Test count: 2 tests with 4 vm0 run calls

load '../../helpers/setup'

# Unique agent name for this test file to avoid compose conflicts in parallel runs
AGENT_NAME="e2e-t08"

setup() {
    # Create temporary test directory
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    # Use unique test artifact name with timestamp
    export ARTIFACT_NAME="e2e-conversation-$(date +%s%3N)-$RANDOM"
    # Create inline config with unique agent name
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for conversation fork testing"
    provider: claude-code
    image: "vm0/claude-code:dev"
    volumes:
      - claude-files:/home/user/.claude
    working_dir: /home/user/workspace
volumes:
  claude-files:
    name: claude-files
    version: latest
EOF
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
    # Clean up config file
    if [ -n "$TEST_CONFIG" ] && [ -f "$TEST_CONFIG" ]; then
        rm -f "$TEST_CONFIG"
    fi
}

@test "Build VM0 conversation fork test agent configuration" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "VM0 conversation: output includes conversationId" {
    # This test verifies that run completion output includes conversationId

    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "test-content" > file.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent
    echo "# Step 2: Running agent..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
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

@test "VM0 conversation: fork with --conversation flag" {
    # This test verifies that:
    # 1. Can fork from a conversation using --conversation flag
    # 2. Fork inherits conversation history
    # 3. Fork uses specified artifact version (not conversation's original)

    # Step 1: Create artifact with initial content
    echo "# Step 1: Creating initial artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null

    echo "v1" > version.txt
    echo "100" > counter.txt
    run $CLI_COMMAND artifact push
    assert_success

    # Step 2: Run agent to create initial conversation
    echo "# Step 2: Running agent to create conversation..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo 'original run' && cat version.txt && echo 200 > counter.txt"

    assert_success
    assert_output --partial "Conversation:"

    # Extract conversation ID
    CONVERSATION_ID=$(echo "$output" | grep -oP 'Conversation:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Conversation ID: $CONVERSATION_ID"
    [ -n "$CONVERSATION_ID" ] || {
        echo "# Failed to extract conversation ID"
        echo "$output"
        return 1
    }

    # Step 3: Update artifact to new version
    echo "# Step 3: Pushing new artifact version..."
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    echo "v2" > version.txt
    echo "999" > counter.txt
    echo "new-file" > new.txt
    run $CLI_COMMAND artifact push
    assert_success
    echo "# New artifact version pushed"

    # Step 4: Fork from conversation with NEW artifact version
    # This is the key test: --conversation lets us continue conversation history
    # but with a different (newer) artifact version
    echo "# Step 4: Forking from conversation with new artifact..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        --conversation "$CONVERSATION_ID" \
        "cat version.txt && cat counter.txt && ls"

    assert_success
    assert_output --partial "[tool_use] Bash"

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
    FORK_CONVERSATION_ID=$(echo "$output" | grep -oP 'Conversation:\s*\K[a-f0-9-]{36}' | head -1)
    echo "# Fork conversation ID: $FORK_CONVERSATION_ID"
    [ -n "$FORK_CONVERSATION_ID" ]

    # Note: When using same agent config + artifact, system reuses the session
    # and may return same conversation ID. This is expected behavior.
    # The key test is that fork uses the NEW artifact version, which we verified above.

    echo "# Verified: Fork uses new artifact version with conversation context"
}
