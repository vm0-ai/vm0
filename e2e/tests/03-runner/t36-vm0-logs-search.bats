#!/usr/bin/env bats

# Test VM0 logs search functionality
# This test verifies that:
# 1. vm0 logs search --help shows command options
# 2. vm0 logs search finds events by keyword in a completed run
# 3. vm0 logs search shows empty results guidance for non-matching keywords
#
# Test count: 3 tests with 1 vm0 run call

load '../../helpers/setup'

setup_file() {
    export AGENT_NAME="e2e-t36-$(date +%s%3N)-$RANDOM"
    export TEST_DIR="$(mktemp -d)"

    # Create volume and compose ONCE so parallel tests don't race
    create_test_volume "e2e-vol-t36"
    export SHARED_VOLUME_NAME="$VOLUME_NAME"
    export SHARED_VOLUME_DIR="$TEST_VOLUME_DIR"

    export SHARED_CONFIG="$TEST_DIR/vm0.yaml"
    cat > "$SHARED_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for logs search testing"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: $SHARED_VOLUME_NAME
    version: latest
EOF
    $VM0_CLI compose "$SHARED_CONFIG" >/dev/null
}

teardown_file() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
    if [ -n "$SHARED_VOLUME_DIR" ] && [ -d "$SHARED_VOLUME_DIR" ]; then
        rm -rf "$SHARED_VOLUME_DIR"
    fi
}

setup() {
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
    export ARTIFACT_NAME="e2e-search-test-$(date +%s%3N)-$RANDOM"
}

teardown() {
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

@test "logs search --help shows command options" {
    run $VM0_CLI logs search --help
    assert_success
    assert_output --partial "Search agent events across runs"
    assert_output --partial "--after-context"
    assert_output --partial "--before-context"
    assert_output --partial "--context"
    assert_output --partial "--agent"
    assert_output --partial "--run"
    assert_output --partial "--since"
    assert_output --partial "--limit"
}

@test "Build logs search test agent configuration" {
    run $VM0_CLI compose "$SHARED_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "logs search: run agent and search for keyword in events" {
    # Step 1: Create artifact
    echo "# Step 1: Creating artifact..."
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "search test content" > test.txt
    run $VM0_CLI artifact push
    assert_success

    # Step 2: Run agent
    echo "# Step 2: Running agent..."
    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "echo 'hello from agent'"
    assert_success
    assert_output --partial "Run ID:"
    assert_output --partial "◆ Claude Code Completed"

    # Step 3: Extract Run ID
    RUN_ID=$(echo "$output" | grep -oP 'Run ID:\s+\K[a-f0-9-]{36}' | head -1)
    echo "# Run ID: $RUN_ID"
    [ -n "$RUN_ID" ] || {
        echo "# Failed to extract Run ID"
        echo "$output"
        return 1
    }

    # Step 4: Search for keyword scoped to this run
    echo "# Step 4: Searching for 'hello from agent' in run events..."
    SHORT_ID="${RUN_ID:0:8}"
    wait_for_log search "hello from agent" --run "$RUN_ID" --since 1h -- "$SHORT_ID"

    # Step 5: Search for non-matching keyword shows empty guidance
    echo "# Step 5: Testing empty results guidance..."
    run $VM0_CLI logs search "xyznonexistent99999" --run "$RUN_ID" --since 1h
    assert_success
    assert_output --partial "No matches found"
}
