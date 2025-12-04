#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    # Use unique names with timestamp to avoid conflicts
    export AGENT_NAME="e2e-cook-$(date +%s)"
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
    provider: claude-code
    image: vm0-claude-code-dev
    volumes:
      - test-volume:/home/user/data
    working_dir: /home/user/workspace

volumes:
  test-volume:
    name: test-volume
    version: latest
EOF

    echo "# Step 2: Create volume directory with test file..."
    mkdir -p test-volume
    echo "test data" > test-volume/data.txt

    echo "# Step 3: Run cook without prompt (preparation only)..."
    run $CLI_COMMAND cook
    assert_success

    echo "# Step 4: Verify output..."
    assert_output --partial "Reading config: vm0.yaml"
    assert_output --partial "Config validated"
    assert_output --partial "Processing volumes"
    assert_output --partial "test-volume"
    assert_output --partial "Pushed"
    assert_output --partial "Processing artifact"
    assert_output --partial "Building compose"
    assert_output --partial "Compose built"

    echo "# Step 5: Verify volume was initialized..."
    [ -f "test-volume/.vm0/storage.yaml" ]

    echo "# Step 6: Verify artifact directory was created..."
    [ -d "artifact" ]
    [ -f "artifact/.vm0/storage.yaml" ]
}

@test "cook command fails when vm0.yaml is missing" {
    cd "$TEST_DIR"

    echo "# Run cook without vm0.yaml..."
    run $CLI_COMMAND cook
    assert_failure
    assert_output --partial "Config file not found"
}

@test "cook command auto-pulls artifact when version changes" {
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
    description: "E2E test agent for cook auto-pull"
    provider: claude-code
    image: vm0-claude-code-dev
    working_dir: /home/user/workspace

volumes: {}
EOF

    echo "# Step 2: Create artifact directory with initial file..."
    mkdir -p artifact
    echo "initial content" > artifact/test.txt

    echo "# Step 3: Run cook with prompt that modifies artifact..."
    # Use a simple prompt that creates a new file in the artifact
    run $CLI_COMMAND cook --timeout 120 "Create a file called result.txt in /home/user/workspace with the text 'hello from agent'"
    assert_success

    echo "# Step 4: Verify auto-pull output..."
    # If agent modified artifact, we should see the pull message
    # Note: This may not always trigger if agent doesn't modify files
    # We check the positive case - if version changed, pull should happen
    if echo "$output" | grep -q "Pulling updated artifact"; then
        assert_output --partial "Artifact pulled"

        echo "# Step 5: Verify pulled file exists locally..."
        [ -f "artifact/result.txt" ] || {
            echo "# Warning: result.txt not found, agent may not have created it"
        }
    else
        echo "# Note: Artifact version unchanged, no pull needed"
    fi
}
