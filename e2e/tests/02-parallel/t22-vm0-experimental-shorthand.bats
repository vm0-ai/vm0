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
# E2E Integration Tests
# ============================================
# These tests require actual runtime execution and cannot be
# unit tested because they verify:
# - Full CLI compose/run pipeline
# - Secret masking in live output
# - Runtime variable expansion
#
# Schema validation tests (non-array, non-string, empty string)
# are covered by unit tests in:
#   turbo/apps/cli/src/lib/domain/__tests__/yaml-validator.test.ts
#
# Transformation and precedence tests are covered by unit tests in:
#   turbo/apps/cli/src/commands/__tests__/compose.test.ts
#
# Missing required values tests are covered by unit tests in:
#   turbo/apps/web/src/lib/run/environment/__tests__/expand-environment.test.ts
# ============================================

@test "vm0 compose transforms experimental_secrets shorthand to environment" {
    echo "# Step 1: Create config with experimental_secrets"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with experimental_secrets shorthand"
    framework: claude-code
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
    framework: claude-code
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
    framework: claude-code
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
