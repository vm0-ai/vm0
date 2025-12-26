#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    export TEST_CONFIG="${TEST_ROOT}/fixtures/configs/vm0-experimental-shorthand.yaml"
    export TEST_CONFIG_PRECEDENCE="${TEST_ROOT}/fixtures/configs/vm0-experimental-shorthand-precedence.yaml"
    export UNIQUE_ID="$(date +%s)"
    export ARTIFACT_NAME="e2e-exp-shorthand-${UNIQUE_ID}"
    export TEST_ARTIFACT_DIR="$(mktemp -d)"
}

teardown() {
    # Clean up temporary directories
    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
}

# Helper to create artifact for tests
setup_artifact() {
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1
}

# Test: experimental_secrets shorthand works correctly
@test "vm0 compose transforms experimental_secrets shorthand to environment" {
    echo "# Step 1: Compose the config with experimental_secrets"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "Compose"
}

@test "vm0 run with experimental_secrets shorthand expands secrets correctly" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Compose the config"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 3: Run with secrets (shorthand should have transformed them)"
    local API_KEY_VALUE="api-key-${UNIQUE_ID}"
    local DB_URL_VALUE="db-url-${UNIQUE_ID}"
    local CLOUD_NAME_VALUE="cloud-${UNIQUE_ID}"
    local REGION_VALUE="region-${UNIQUE_ID}"

    run $CLI_COMMAND run vm0-experimental-shorthand \
        --secrets "API_KEY=${API_KEY_VALUE}" \
        --secrets "DB_URL=${DB_URL_VALUE}" \
        --vars "CLOUD_NAME=${CLOUD_NAME_VALUE}" \
        --vars "REGION=${REGION_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        --timeout 120 \
        "echo API_KEY=\$API_KEY && echo DB_URL=\$DB_URL && echo CLOUD_NAME=\$CLOUD_NAME && echo REGION=\$REGION"
    assert_success

    echo "# Step 4: Verify secrets are masked"
    assert_output --partial "API_KEY=***"
    assert_output --partial "DB_URL=***"
    refute_output --partial "api-key-"
    refute_output --partial "db-url-"

    echo "# Step 5: Verify vars are expanded"
    assert_output --partial "CLOUD_NAME=${CLOUD_NAME_VALUE}"
    assert_output --partial "REGION=${REGION_VALUE}"
}

@test "vm0 run with experimental_vars shorthand expands vars correctly" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Compose the config"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 3: Run with vars (shorthand should have transformed them)"
    local CLOUD_NAME_VALUE="mycloud-${UNIQUE_ID}"
    local REGION_VALUE="us-east-${UNIQUE_ID}"

    run $CLI_COMMAND run vm0-experimental-shorthand \
        --secrets "API_KEY=secret1" \
        --secrets "DB_URL=secret2" \
        --vars "CLOUD_NAME=${CLOUD_NAME_VALUE}" \
        --vars "REGION=${REGION_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        --timeout 120 \
        "echo CLOUD_NAME=\$CLOUD_NAME && echo REGION=\$REGION"
    assert_success

    echo "# Step 4: Verify vars are expanded correctly"
    assert_output --partial "CLOUD_NAME=${CLOUD_NAME_VALUE}"
    assert_output --partial "REGION=${REGION_VALUE}"
}

@test "vm0 run fails when experimental_secrets shorthand secrets are missing" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Compose the config"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 3: Run without providing required secrets"
    run $CLI_COMMAND run vm0-experimental-shorthand \
        --vars "CLOUD_NAME=cloud" \
        --vars "REGION=region" \
        --artifact-name "$ARTIFACT_NAME" \
        --timeout 120 \
        "echo hello"
    assert_failure

    echo "# Step 4: Verify error mentions missing secrets"
    assert_output --partial "Missing required secrets"
    assert_output --partial "API_KEY"
}

@test "vm0 run fails when experimental_vars shorthand vars are missing" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Compose the config"
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 3: Run without providing required vars"
    run $CLI_COMMAND run vm0-experimental-shorthand \
        --secrets "API_KEY=secret1" \
        --secrets "DB_URL=secret2" \
        --artifact-name "$ARTIFACT_NAME" \
        --timeout 120 \
        "echo hello"
    assert_failure

    echo "# Step 4: Verify error mentions missing vars"
    assert_output --partial "Missing required"
    assert_output --partial "CLOUD_NAME"
}

@test "vm0 compose explicit environment takes precedence over experimental_secrets shorthand" {
    echo "# Step 1: Create and push artifact"
    setup_artifact

    echo "# Step 2: Compose the config with precedence test"
    run $CLI_COMMAND compose "$TEST_CONFIG_PRECEDENCE"
    assert_success

    echo "# Step 3: Run with secrets - OVERRIDE_SECRET should use DIFFERENT_SECRET"
    local API_KEY_VALUE="api-key-${UNIQUE_ID}"
    local OVERRIDE_SECRET_VALUE="override-${UNIQUE_ID}"
    local DIFFERENT_SECRET_VALUE="different-${UNIQUE_ID}"
    local CLOUD_NAME_VALUE="cloud-${UNIQUE_ID}"

    run $CLI_COMMAND run vm0-exp-shorthand-prec \
        --secrets "API_KEY=${API_KEY_VALUE}" \
        --secrets "DIFFERENT_SECRET=${DIFFERENT_SECRET_VALUE}" \
        --vars "CLOUD_NAME=${CLOUD_NAME_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        --timeout 120 \
        "echo API_KEY=\$API_KEY && echo OVERRIDE_SECRET=\$OVERRIDE_SECRET && echo EXPLICIT_VAR=\$EXPLICIT_VAR"
    assert_success

    echo "# Step 4: Verify API_KEY is masked (from shorthand)"
    assert_output --partial "API_KEY=***"

    echo "# Step 5: Verify OVERRIDE_SECRET is masked (from explicit environment pointing to DIFFERENT_SECRET)"
    assert_output --partial "OVERRIDE_SECRET=***"

    echo "# Step 6: Verify EXPLICIT_VAR has hardcoded value"
    assert_output --partial "EXPLICIT_VAR=hardcoded-value"
}

@test "vm0 compose validation rejects invalid experimental_secrets (non-array)" {
    echo "# Step 1: Create invalid config"
    local INVALID_CONFIG="$(mktemp)"
    cat > "$INVALID_CONFIG" <<EOF
version: "1.0"

agents:
  invalid-agent:
    provider: claude-code
    experimental_secrets: "should-be-array"
EOF

    echo "# Step 2: Try to compose - should fail validation"
    run $CLI_COMMAND compose "$INVALID_CONFIG"
    assert_failure
    assert_output --partial "must be an array"

    rm -f "$INVALID_CONFIG"
}

@test "vm0 compose validation rejects invalid experimental_vars (non-string entry)" {
    echo "# Step 1: Create invalid config"
    local INVALID_CONFIG="$(mktemp)"
    cat > "$INVALID_CONFIG" <<'EOF'
version: "1.0"

agents:
  invalid-agent:
    provider: claude-code
    experimental_vars:
      - 123
EOF

    echo "# Step 2: Try to compose - should fail validation"
    run $CLI_COMMAND compose "$INVALID_CONFIG"
    assert_failure
    assert_output --partial "must be a string"

    rm -f "$INVALID_CONFIG"
}

@test "vm0 compose validation rejects empty string in experimental_secrets" {
    echo "# Step 1: Create invalid config"
    local INVALID_CONFIG="$(mktemp)"
    cat > "$INVALID_CONFIG" <<'EOF'
version: "1.0"

agents:
  invalid-agent:
    provider: claude-code
    experimental_secrets:
      - API_KEY
      - ""
EOF

    echo "# Step 2: Try to compose - should fail validation"
    run $CLI_COMMAND compose "$INVALID_CONFIG"
    assert_failure
    assert_output --partial "cannot be empty"

    rm -f "$INVALID_CONFIG"
}

@test "vm0 compose accepts empty experimental_secrets array" {
    echo "# Step 1: Create config with empty arrays"
    local EMPTY_CONFIG="$(mktemp)"
    cat > "$EMPTY_CONFIG" <<'EOF'
version: "1.0"

agents:
  empty-arrays:
    provider: claude-code
    experimental_secrets: []
    experimental_vars: []
EOF

    echo "# Step 2: Compose should succeed"
    run $CLI_COMMAND compose "$EMPTY_CONFIG"
    assert_success

    rm -f "$EMPTY_CONFIG"
}
