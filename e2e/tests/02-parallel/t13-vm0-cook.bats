#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    # Use unique names with timestamp to avoid conflicts in parallel runs
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-cook-${UNIQUE_ID}"
    export VOLUME_NAME="e2e-cook-vol-${UNIQUE_ID}"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "cook command reads vm0.yaml and prepares agent with volume" {
    # Skip if not authenticated (requires VM0_TOKEN or logged in)
    if $CLI_COMMAND auth status 2>&1 | grep -q "Not authenticated"; then
        skip "Not authenticated - run 'vm0 auth login' first"
    fi

    cd "$TEST_DIR"

    echo "# Step 1: Create vm0.yaml config with volume..."
    cat > vm0.yaml <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "E2E test agent for cook command"
    framework: claude-code
    image: "vm0/claude-code:dev"
    volumes:
      - ${VOLUME_NAME}:/home/user/data
    working_dir: /home/user/workspace

volumes:
  ${VOLUME_NAME}:
    name: ${VOLUME_NAME}
    version: latest
EOF

    echo "# Step 2: Create volume directory with test file..."
    mkdir -p "$VOLUME_NAME"
    echo "test data" > "$VOLUME_NAME/data.txt"

    echo "# Step 3: Run cook without prompt (preparation only)..."
    run $CLI_COMMAND cook --no-auto-update
    assert_success

    echo "# Step 4: Verify output..."
    assert_output --partial "Reading config: vm0.yaml"
    assert_output --partial "Config validated"
    assert_output --partial "Processing volumes"
    assert_output --partial "cd $VOLUME_NAME"
    assert_output --partial "vm0 volume push"
    assert_output --partial "Processing artifact"
    assert_output --partial "Composing agent"
    assert_output --partial "vm0 compose vm0.yaml"

    echo "# Step 5: Verify volume was initialized..."
    [ -f "$VOLUME_NAME/.vm0/storage.yaml" ]

    echo "# Step 6: Verify artifact directory was created..."
    [ -d "artifact" ]
    [ -f "artifact/.vm0/storage.yaml" ]

    echo "# Step 7: Run cook with prompt to test auto-pull..."
    # Use bash command for mock agent compatibility
    run $CLI_COMMAND cook --no-auto-update "echo 'hello' > /home/user/workspace/result.txt"
    # Verify cook started the run
    assert_output --partial "Running agent"
    # Check for init event (Claude Code Started) which indicates agent started (replaces vm0_start)
    assert_output --partial "▷ Claude Code Started"

    echo "# Step 8: Check auto-pull behavior..."
    # If run succeeded and version changed, we should see pull message
    # Check for "Run completed successfully" which indicates run finished
    if echo "$output" | grep -q "Run completed successfully"; then
        if echo "$output" | grep -q "Pulling updated artifact"; then
            assert_output --partial "vm0 artifact pull"
            echo "# Auto-pull triggered successfully"
        else
            echo "# Artifact version unchanged - no pull needed"
        fi
    fi
}

@test "cook command succeeds when variables are set via --env-file" {
    # Skip if not authenticated (requires VM0_TOKEN or logged in)
    if $CLI_COMMAND auth status 2>&1 | grep -q "Not authenticated"; then
        skip "Not authenticated - run 'vm0 auth login' first"
    fi

    cd "$TEST_DIR"

    echo "# Step 1: Create vm0.yaml with variable references..."
    cat > vm0.yaml <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "E2E test agent for env check"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      API_KEY: \${{ vars.E2E_TEST_VAR }}
EOF

    echo "# Step 2: Create .env file with values..."
    cat > .env <<EOF
E2E_TEST_VAR=test-value-123
EOF

    echo "# Step 3: Run cook with --env-file (should succeed)..."
    run $CLI_COMMAND cook --no-auto-update --env-file .env
    assert_success

    echo "# Step 4: Verify normal cook output..."
    assert_output --partial "Config validated"
    assert_output --partial "Composing agent"
    assert_output --partial "vm0 compose vm0.yaml"
}

@test "cook command with skills downloads and composes correctly" {
    # Skip if not authenticated (requires VM0_TOKEN or logged in)
    if $CLI_COMMAND auth status 2>&1 | grep -q "Not authenticated"; then
        skip "Not authenticated - run 'vm0 auth login' first"
    fi

    cd "$TEST_DIR"

    echo "# Step 1: Create vm0.yaml config with skill..."
    cat > vm0.yaml <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "E2E test agent for cook with skills"
    framework: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
EOF

    echo "# Step 2: Run cook without prompt (preparation only)..."
    run $CLI_COMMAND cook --no-auto-update --yes
    assert_success

    echo "# Step 3: Verify compose was called and skill was processed..."
    assert_output --partial "vm0 compose --yes vm0.yaml"
    assert_output --partial "Downloading"
    assert_output --partial "github"
    # Skill upload should succeed
    assert_output --partial "Skill"
}
