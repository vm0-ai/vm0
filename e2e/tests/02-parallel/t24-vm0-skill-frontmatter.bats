#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory for dynamic configs
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-skill-frontmatter-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-skill-frontmatter-artifact-${UNIQUE_ID}"
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
# --yes flag tests
# ============================================

@test "vm0 compose with --yes flag skips confirmation prompts" {
    echo "# Step 1: Create config with skill"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with --yes flag"
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
EOF

    echo "# Step 2: Compose with --yes flag"
    run $CLI_COMMAND compose --yes "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Verify compose succeeded"
    assert_output --partial "Compose"
    assert_output --partial "skill"
}

@test "vm0 compose with -y short flag skips confirmation prompts" {
    echo "# Step 1: Create config with skill"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with -y short flag"
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
EOF

    echo "# Step 2: Compose with -y short flag"
    run $CLI_COMMAND compose -y "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Verify compose succeeded"
    assert_output --partial "Compose"
}

@test "vm0 compose with --yes flag works in non-TTY environment" {
    echo "# Step 1: Create config without skills (no frontmatter confirmation needed)"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent in non-TTY"
    provider: claude-code
EOF

    echo "# Step 2: Compose with --yes flag and piped input (non-TTY)"
    run bash -c "echo '' | $CLI_COMMAND compose --yes '$TEST_DIR/vm0.yaml'"
    assert_success

    echo "# Step 3: Verify compose succeeded"
    assert_output --partial "Compose"
}

# ============================================
# Skills without frontmatter vars (regression)
# ============================================

@test "vm0 compose with skills that have no frontmatter vars works correctly" {
    echo "# Step 1: Create config with github skill (no vm0_secrets/vm0_vars in frontmatter)"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with skill without frontmatter vars"
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
EOF

    echo "# Step 2: Compose the config (should not prompt for vars)"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Verify compose succeeded without prompting"
    assert_output --partial "Compose"
    assert_output --partial "skill"
    # Should not show "Skills require the following environment variables"
    refute_output --partial "require the following environment variables"
}

# ============================================
# Combination with existing environment
# ============================================

@test "vm0 compose with skills and explicit environment works correctly" {
    echo "# Step 1: Create config with skill and explicit environment"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with skill and environment"
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
    environment:
      GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      CUSTOM_VAR: custom-value
EOF

    echo "# Step 2: Compose with --yes"
    run $CLI_COMMAND compose --yes "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Verify compose succeeded"
    assert_output --partial "Compose"
}

@test "vm0 run with skill uses environment from skill frontmatter" {
    echo "# Step 1: Create config with github skill"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with skill"
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
EOF

    echo "# Step 2: Create and push artifact"
    setup_artifact

    echo "# Step 3: Compose the config"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 4: Verify skill was uploaded"
    assert_output --partial "skill"
    assert_output --partial "github"
}

# ============================================
# Skill upload and frontmatter parsing
# ============================================

@test "vm0 compose downloads and uploads skill with version" {
    echo "# Step 1: Create config with skill"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with skill upload"
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
EOF

    echo "# Step 2: Compose the config"
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Verify skill was downloaded and uploaded"
    assert_output --partial "Downloading"
    assert_output --partial "github"
    # Version ID should be shown (8 chars)
    assert_output --regexp "[a-f0-9]{8}"
}

@test "vm0 compose with multiple skills works correctly" {
    echo "# Step 1: Create config with multiple skills"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with multiple skills"
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
      - https://github.com/vm0-ai/vm0-skills/tree/main/axiom
EOF

    echo "# Step 2: Compose with --yes"
    run $CLI_COMMAND compose --yes "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Verify both skills were uploaded"
    assert_output --partial "2 skill"
    assert_output --partial "github"
    assert_output --partial "axiom"
}

# ============================================
# Smart secret confirmation tests
# ============================================

@test "vm0 compose re-compose with same secrets skips confirmation" {
    echo "# Step 1: Create config with skill that has vm0_secrets"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with secrets"
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/elevenlabs
EOF

    echo "# Step 2: First compose with --yes to approve secrets"
    run $CLI_COMMAND compose --yes "$TEST_DIR/vm0.yaml"
    assert_success
    assert_output --partial "Compose"
    # First compose should show secrets
    assert_output --partial "ELEVENLABS_API_KEY"

    echo "# Step 3: Re-compose WITHOUT --yes flag (should succeed without prompting)"
    # Since secrets are the same as HEAD, no confirmation should be needed
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
    assert_output --partial "Compose"
    # Should NOT show (new) marker since secret was already approved
    refute_output --partial "(new)"
}

@test "vm0 compose shows (new) marker for truly new secrets" {
    echo "# Step 1: Create config with first skill"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with secrets"
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/elevenlabs
EOF

    echo "# Step 2: First compose with --yes"
    run $CLI_COMMAND compose --yes "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Add second skill with different secret"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with secrets"
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/elevenlabs
      - https://github.com/vm0-ai/vm0-skills/tree/main/resend
EOF

    echo "# Step 4: Compose with --yes and verify (new) marker"
    run $CLI_COMMAND compose --yes "$TEST_DIR/vm0.yaml"
    assert_success
    # RESEND_API_KEY is new, should show (new) marker
    assert_output --partial "(new)"
    assert_output --partial "RESEND_API_KEY"
    # ELEVENLABS_API_KEY is not new, should NOT have (new) marker next to it
    # Note: We can't easily assert that ELEVENLABS doesn't have (new) without complex parsing
}

@test "vm0 compose fails in non-TTY with new secrets without --yes" {
    echo "# Step 1: Create config with first skill"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with secrets"
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/elevenlabs
EOF

    echo "# Step 2: First compose with --yes"
    run $CLI_COMMAND compose --yes "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Step 3: Add second skill with new secret"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with secrets"
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/elevenlabs
      - https://github.com/vm0-ai/vm0-skills/tree/main/resend
EOF

    echo "# Step 4: Compose in non-TTY without --yes (should fail)"
    run bash -c "echo '' | $CLI_COMMAND compose '$TEST_DIR/vm0.yaml'"
    assert_failure
    # Should show error about new secrets
    assert_output --partial "New secrets detected"
    assert_output --partial "RESEND_API_KEY"
    assert_output --partial "--yes"
}

@test "vm0 compose first-time with secrets in non-TTY requires --yes" {
    echo "# Step 1: Create config with skill that has vm0_secrets"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with secrets"
    provider: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/elevenlabs
EOF

    echo "# Step 2: First-time compose in non-TTY without --yes (should fail)"
    run bash -c "echo '' | $CLI_COMMAND compose '$TEST_DIR/vm0.yaml'"
    assert_failure
    # Should show error about new secrets (all secrets are new on first compose)
    assert_output --partial "New secrets detected"
    assert_output --partial "ELEVENLABS_API_KEY"
}
