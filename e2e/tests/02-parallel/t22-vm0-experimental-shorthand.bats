#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory for dynamic configs
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-exp-shorthand-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-exp-shorthand-artifact-${UNIQUE_ID}"
}

teardown() {
    # Clean up temporary directories
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# Helper to create artifact for tests
setup_artifact() {
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1
}

# ============================================
# Transformation tests
# ============================================

@test "vm0 compose transforms experimental_secrets shorthand to environment" {
    echo "# Step 1: Create config with experimental_secrets"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with experimental_secrets shorthand"
    provider: claude-code
    experimental_secrets:
      - API_KEY
      - DB_URL
    experimental_vars:
      - CLOUD_NAME
      - REGION
EOF

    echo "# Step 2: Compose the config"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
    assert_output --partial "Compose"
}

@test "vm0 run with experimental_secrets shorthand expands secrets correctly" {
    echo "# Step 1: Create config with experimental_secrets"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with secrets shorthand"
    provider: claude-code
    experimental_secrets:
      - API_KEY
      - DB_URL
    experimental_vars:
      - CLOUD_NAME
      - REGION
EOF

    echo "# Step 2: Create and push artifact"
    setup_artifact

    echo "# Step 3: Compose the config"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run with secrets (shorthand should have transformed them)"
    local API_KEY_VALUE="api-key-${UNIQUE_ID}"
    local DB_URL_VALUE="db-url-${UNIQUE_ID}"
    local CLOUD_NAME_VALUE="cloud-${UNIQUE_ID}"
    local REGION_VALUE="region-${UNIQUE_ID}"

    run $CLI_COMMAND run "$AGENT_NAME" \
        --secrets "API_KEY=${API_KEY_VALUE}" \
        --secrets "DB_URL=${DB_URL_VALUE}" \
        --vars "CLOUD_NAME=${CLOUD_NAME_VALUE}" \
        --vars "REGION=${REGION_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo API_KEY=\$API_KEY && echo DB_URL=\$DB_URL && echo CLOUD_NAME=\$CLOUD_NAME && echo REGION=\$REGION"
    assert_success

    echo "# Step 5: Verify secrets are masked"
    assert_output --partial "API_KEY=***"
    assert_output --partial "DB_URL=***"
    refute_output --partial "api-key-"
    refute_output --partial "db-url-"

    echo "# Step 6: Verify vars are expanded"
    assert_output --partial "CLOUD_NAME=${CLOUD_NAME_VALUE}"
    assert_output --partial "REGION=${REGION_VALUE}"
}

@test "vm0 run with experimental_vars shorthand expands vars correctly" {
    echo "# Step 1: Create config with experimental_vars"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with vars shorthand"
    provider: claude-code
    experimental_secrets:
      - API_KEY
      - DB_URL
    experimental_vars:
      - CLOUD_NAME
      - REGION
EOF

    echo "# Step 2: Create and push artifact"
    setup_artifact

    echo "# Step 3: Compose the config"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run with vars (shorthand should have transformed them)"
    local CLOUD_NAME_VALUE="mycloud-${UNIQUE_ID}"
    local REGION_VALUE="us-east-${UNIQUE_ID}"

    run $CLI_COMMAND run "$AGENT_NAME" \
        --secrets "API_KEY=secret1" \
        --secrets "DB_URL=secret2" \
        --vars "CLOUD_NAME=${CLOUD_NAME_VALUE}" \
        --vars "REGION=${REGION_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo CLOUD_NAME=\$CLOUD_NAME && echo REGION=\$REGION"
    assert_success

    echo "# Step 5: Verify vars are expanded correctly"
    assert_output --partial "CLOUD_NAME=${CLOUD_NAME_VALUE}"
    assert_output --partial "REGION=${REGION_VALUE}"
}

# ============================================
# Missing required values tests
# ============================================

@test "vm0 run fails when experimental_secrets shorthand secrets are missing" {
    echo "# Step 1: Create config with experimental_secrets"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent requiring secrets"
    provider: claude-code
    experimental_secrets:
      - API_KEY
      - DB_URL
    experimental_vars:
      - CLOUD_NAME
      - REGION
EOF

    echo "# Step 2: Create and push artifact"
    setup_artifact

    echo "# Step 3: Compose the config"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run without providing required secrets"
    run $CLI_COMMAND run "$AGENT_NAME" \
        --vars "CLOUD_NAME=cloud" \
        --vars "REGION=region" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello"
    assert_failure

    echo "# Step 5: Verify error mentions missing secrets"
    assert_output --partial "Missing required secrets"
    assert_output --partial "API_KEY"
}

@test "vm0 run fails when experimental_vars shorthand vars are missing" {
    echo "# Step 1: Create config with experimental_vars"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent requiring vars"
    provider: claude-code
    experimental_secrets:
      - API_KEY
      - DB_URL
    experimental_vars:
      - CLOUD_NAME
      - REGION
EOF

    echo "# Step 2: Create and push artifact"
    setup_artifact

    echo "# Step 3: Compose the config"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run without providing required vars"
    run $CLI_COMMAND run "$AGENT_NAME" \
        --secrets "API_KEY=secret1" \
        --secrets "DB_URL=secret2" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello"
    assert_failure

    echo "# Step 5: Verify error mentions missing vars"
    assert_output --partial "Missing required"
    assert_output --partial "CLOUD_NAME"
}

# ============================================
# Precedence tests
# ============================================

@test "vm0 compose explicit environment takes precedence over experimental_secrets shorthand" {
    echo "# Step 1: Create config with both shorthand and explicit environment"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test precedence of explicit environment over shorthand"
    provider: claude-code
    experimental_secrets:
      - API_KEY
    experimental_vars:
      - CLOUD_NAME
    environment:
      OVERRIDE_SECRET: \${{ secrets.DIFFERENT_SECRET }}
      EXPLICIT_VAR: hardcoded-value
EOF

    echo "# Step 2: Create and push artifact"
    setup_artifact

    echo "# Step 3: Compose the config with precedence test"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Run with secrets - OVERRIDE_SECRET should use DIFFERENT_SECRET"
    local API_KEY_VALUE="api-key-${UNIQUE_ID}"
    local DIFFERENT_SECRET_VALUE="different-${UNIQUE_ID}"
    local CLOUD_NAME_VALUE="cloud-${UNIQUE_ID}"

    run $CLI_COMMAND run "$AGENT_NAME" \
        --secrets "API_KEY=${API_KEY_VALUE}" \
        --secrets "DIFFERENT_SECRET=${DIFFERENT_SECRET_VALUE}" \
        --vars "CLOUD_NAME=${CLOUD_NAME_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo API_KEY=\$API_KEY && echo OVERRIDE_SECRET=\$OVERRIDE_SECRET && echo EXPLICIT_VAR=\$EXPLICIT_VAR"
    assert_success

    echo "# Step 5: Verify API_KEY is masked (from shorthand)"
    assert_output --partial "API_KEY=***"

    echo "# Step 6: Verify OVERRIDE_SECRET is masked (from explicit environment pointing to DIFFERENT_SECRET)"
    assert_output --partial "OVERRIDE_SECRET=***"

    echo "# Step 7: Verify EXPLICIT_VAR has hardcoded value"
    assert_output --partial "EXPLICIT_VAR=hardcoded-value"
}

# ============================================
# Validation tests
# ============================================

@test "vm0 compose validation rejects invalid experimental_secrets (non-array)" {
    echo "# Step 1: Create invalid config"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  invalid-agent:
    provider: claude-code
    experimental_secrets: "should-be-array"
EOF

    echo "# Step 2: Try to compose - should fail validation"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    assert_output --partial "must be an array"
}

@test "vm0 compose validation rejects invalid experimental_vars (non-string entry)" {
    echo "# Step 1: Create invalid config"
    cat > "$TEST_DIR/vm0.yaml" <<'EOF'
version: "1.0"

agents:
  invalid-agent:
    provider: claude-code
    experimental_vars:
      - 123
EOF

    echo "# Step 2: Try to compose - should fail validation"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    assert_output --partial "must be a string"
}

@test "vm0 compose validation rejects empty string in experimental_secrets" {
    echo "# Step 1: Create invalid config"
    cat > "$TEST_DIR/vm0.yaml" <<'EOF'
version: "1.0"

agents:
  invalid-agent:
    provider: claude-code
    experimental_secrets:
      - API_KEY
      - ""
EOF

    echo "# Step 2: Try to compose - should fail validation"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    assert_output --partial "cannot be empty"
}

@test "vm0 compose accepts empty experimental_secrets array" {
    echo "# Step 1: Create config with empty arrays"
    cat > "$TEST_DIR/vm0.yaml" <<'EOF'
version: "1.0"

agents:
  empty-arrays:
    provider: claude-code
    experimental_secrets: []
    experimental_vars: []
EOF

    echo "# Step 2: Compose should succeed"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
}
