#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    # Use unique names with timestamp to avoid conflicts in parallel runs
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-real-claude-${UNIQUE_ID}"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "real claude executes simple prompt with --debug-no-mock-claude" {
    # Skip if ANTHROPIC_API_KEY is not set
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        skip "ANTHROPIC_API_KEY not set - required for real Claude test"
    fi

    # Skip if not authenticated (requires VM0_TOKEN or logged in)
    if $CLI_COMMAND auth status 2>&1 | grep -q "Not authenticated"; then
        skip "Not authenticated - run 'vm0 auth login' first"
    fi

    cd "$TEST_DIR"

    echo "# Step 1: Create vm0.yaml config..."
    cat > vm0.yaml <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Real Claude smoke test"
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
EOF

    echo "# Step 2: Create .env file with API key..."
    cat > .env <<EOF
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
EOF

    echo "# Step 3: Run cook with --debug-no-mock-claude flag..."
    # Use a simple prompt that Claude can execute quickly
    # Timeout after 120 seconds to catch hangs
    run timeout 120 $CLI_COMMAND cook --debug-no-mock-claude "echo 'hello from real claude' && exit 0"

    echo "# Step 4: Verify run completed..."
    # Should succeed and produce JSONL output
    assert_success

    echo "# Step 5: Check for expected output markers..."
    # Should see init event
    assert_output --partial "[init]"
    # Should complete successfully
    assert_output --partial "Run completed successfully"
}
