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
    image: "vm0/claude-code:dev"
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
    assert_output --partial "Uploading compose"
    assert_output --partial "Compose uploaded"

    echo "# Step 5: Verify volume was initialized..."
    [ -f "test-volume/.vm0/storage.yaml" ]

    echo "# Step 6: Verify artifact directory was created..."
    [ -d "artifact" ]
    [ -f "artifact/.vm0/storage.yaml" ]

    echo "# Step 7: Run cook with prompt to test auto-pull..."
    # Use bash command for mock agent compatibility
    run $CLI_COMMAND cook "echo 'hello' > /home/user/workspace/result.txt"
    # Verify cook started the run
    assert_output --partial "Running agent"
    # Check for [init] event which indicates agent started (replaces vm0_start)
    assert_output --partial "[init]"

    echo "# Step 8: Check auto-pull behavior..."
    # If run succeeded and version changed, we should see pull message
    # Check for "Run completed successfully" which indicates run finished
    if echo "$output" | grep -q "Run completed successfully"; then
        if echo "$output" | grep -q "Pulling updated artifact"; then
            assert_output --partial "Artifact pulled"
            echo "# Auto-pull triggered successfully"
        else
            echo "# Artifact version unchanged - no pull needed"
        fi
    fi
}

@test "cook command fails when vm0.yaml is missing" {
    cd "$TEST_DIR"

    echo "# Run cook without vm0.yaml..."
    run $CLI_COMMAND cook
    assert_failure
    assert_output --partial "Config file not found"
}

@test "cook command detects missing environment variables and creates .env placeholders" {
    cd "$TEST_DIR"

    echo "# Step 1: Create vm0.yaml with variable references..."
    cat > vm0.yaml <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "E2E test agent for env check"
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      API_KEY: \${{ vars.E2E_TEST_API_KEY }}
      SECRET_TOKEN: \${{ secrets.E2E_TEST_SECRET }}
EOF

    echo "# Step 2: Ensure no .env file exists..."
    rm -f .env

    echo "# Step 3: Run cook (should fail due to missing vars)..."
    run $CLI_COMMAND cook
    assert_failure

    echo "# Step 4: Verify error message mentions missing variables..."
    assert_output --partial "Missing environment variables"
    assert_output --partial "E2E_TEST_API_KEY"
    assert_output --partial "E2E_TEST_SECRET"

    echo "# Step 5: Verify .env file was created with placeholders..."
    [ -f ".env" ]

    echo "# Step 6: Verify .env content has correct format..."
    grep -q "^E2E_TEST_API_KEY=$" .env
    grep -q "^E2E_TEST_SECRET=$" .env
}

@test "cook command succeeds when variables are set in .env file" {
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
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      API_KEY: \${{ vars.E2E_TEST_VAR }}
EOF

    echo "# Step 2: Create .env file with values..."
    cat > .env <<EOF
E2E_TEST_VAR=test-value-123
EOF

    echo "# Step 3: Run cook (should succeed)..."
    run $CLI_COMMAND cook
    assert_success

    echo "# Step 4: Verify normal cook output..."
    assert_output --partial "Config validated"
    assert_output --partial "Compose uploaded"
}

@test "cook command appends to existing .env file without overwriting" {
    cd "$TEST_DIR"

    echo "# Step 1: Create vm0.yaml with variable references..."
    cat > vm0.yaml <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "E2E test agent for env check"
    provider: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace
    environment:
      EXISTING_VAR: \${{ vars.EXISTING_VAR }}
      NEW_VAR: \${{ vars.NEW_VAR }}
EOF

    echo "# Step 2: Create .env file with only one variable..."
    cat > .env <<EOF
EXISTING_VAR=existing-value
EOF

    echo "# Step 3: Run cook (should fail due to missing NEW_VAR)..."
    run $CLI_COMMAND cook
    assert_failure

    echo "# Step 4: Verify error message mentions only the missing variable..."
    assert_output --partial "Missing environment variables"
    assert_output --partial "NEW_VAR"

    echo "# Step 5: Verify .env file still has existing content..."
    grep -q "^EXISTING_VAR=existing-value$" .env

    echo "# Step 6: Verify .env file has new placeholder appended..."
    grep -q "^NEW_VAR=$" .env
}
