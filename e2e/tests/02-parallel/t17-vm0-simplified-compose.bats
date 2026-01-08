#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory for dynamic configs
    export TEST_DIR="$(mktemp -d)"
    # Use unique agent name with timestamp to avoid conflicts
    export AGENT_NAME="e2e-simplified-$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-simplified-artifact-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # Clean up temporary directory
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

# ============================================
# Provider auto-configuration tests
# ============================================

@test "vm0 compose with provider auto-config (image and working_dir)" {
    echo "# Creating config without image or working_dir..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with provider auto-config"
    provider: claude-code
EOF

    echo "# Running vm0 compose..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Verifying image and working_dir were auto-configured..."
    assert_output --partial "Auto-configured image"
    assert_output --partial "Auto-configured working_dir"
    assert_output --partial "Compose created"
}

@test "vm0 compose with explicit image shows deprecation warning" {
    echo "# Creating config with explicit image but without working_dir..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with explicit image"
    provider: claude-code
    image: "vm0/claude-code:dev"
EOF

    echo "# Running vm0 compose..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Verifying deprecation warning and working_dir auto-configured..."
    assert_output --partial "deprecated"
    refute_output --partial "Auto-configured image"
    assert_output --partial "Auto-configured working_dir"
    assert_output --partial "Compose"
}

@test "vm0 compose with explicit working_dir skips working_dir auto-config" {
    echo "# Creating config with explicit image and working_dir..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with explicit config"
    provider: claude-code
    image: vm0/claude-code-github:dev
    working_dir: /custom/path
EOF

    echo "# Running vm0 compose..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Verifying no auto-configuration..."
    refute_output --partial "Auto-configured"
}

@test "vm0 compose with apps selects github image variant" {
    echo "# Creating config with apps field..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with apps"
    provider: claude-code
    apps:
      - github
EOF

    echo "# Running vm0 compose..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Verifying github image variant was auto-configured..."
    assert_output --partial "Auto-configured image"
    assert_output --partial "claude-code-github"
    assert_output --partial "Compose"
}

@test "vm0 compose rejects invalid app" {
    echo "# Creating config with invalid app..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with invalid app"
    provider: claude-code
    apps:
      - invalid-app
EOF

    echo "# Running vm0 compose (should fail)..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    assert_output --partial "Invalid app"
}

@test "vm0 compose rejects invalid app tag" {
    echo "# Creating config with invalid app tag..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with invalid app tag"
    provider: claude-code
    apps:
      - github:invalid-tag
EOF

    echo "# Running vm0 compose (should fail)..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    assert_output --partial "Invalid app tag"
}

@test "vm0 compose requires image for unsupported provider" {
    echo "# Creating config without image for unsupported provider..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent without image"
    provider: unsupported-provider
EOF

    echo "# Running vm0 compose (should fail)..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    assert_output --partial "agent.image"
}

# ============================================
# instructions tests
# ============================================

@test "vm0 compose with instructions uploads file" {
    echo "# Creating config with instructions..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    image: "vm0/claude-code:dev"
    instructions: AGENTS.md
EOF

    echo "# Creating AGENTS.md file..."
    cat > "$TEST_DIR/AGENTS.md" <<EOF
# Test Instructions

You are a test agent. Always respond with TEST_INSTRUCTIONS_LOADED.
EOF

    echo "# Running vm0 compose..."
    cd "$TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_success

    echo "# Verifying instructions upload..."
    assert_output --partial "Uploading instructions"
    assert_output --partial "Instructions"
}

@test "vm0 compose with instructions deduplicates unchanged content" {
    echo "# Creating config with instructions..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    image: "vm0/claude-code:dev"
    instructions: AGENTS.md
EOF

    echo "# Creating AGENTS.md file..."
    cat > "$TEST_DIR/AGENTS.md" <<EOF
# Test Instructions for Deduplication

This content should be deduplicated on second upload.
EOF

    echo "# First compose..."
    cd "$TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_success
    assert_output --partial "Instructions"

    echo "# Second compose with same content..."
    run $CLI_COMMAND compose vm0.yaml
    assert_success
    # Should show unchanged indicator
    assert_output --partial "unchanged"
}

# ============================================
# skills tests
# ============================================

@test "vm0 compose with skills downloads and uploads skill" {
    echo "# Creating config with skills..."
    # Note: Using base image since github variant may not exist yet
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    image: vm0/claude-code:dev
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
EOF

    echo "# Running vm0 compose..."
    run $CLI_COMMAND compose --yes "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Verifying skill download and upload..."
    assert_output --partial "Uploading"
    assert_output --partial "skill"
    assert_output --partial "Downloading"
}

@test "vm0 compose with skills deduplicates unchanged skill" {
    echo "# Creating config with skills..."
    # Note: Using base image since github variant may not exist yet
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    image: vm0/claude-code:dev
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
EOF

    echo "# First compose..."
    run $CLI_COMMAND compose --yes "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Second compose with same skill..."
    run $CLI_COMMAND compose --yes "$TEST_DIR/vm0.yaml"
    assert_success
    # Should show unchanged indicator for the skill
    assert_output --partial "unchanged"
}

# ============================================
# Combined instructions and skills tests
# ============================================

@test "vm0 compose with both instructions and skills" {
    echo "# Creating config with both instructions and skills..."
    # Note: Using base image since github variant may not exist yet
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    image: vm0/claude-code:dev
    instructions: AGENTS.md
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
EOF

    echo "# Creating AGENTS.md file..."
    cat > "$TEST_DIR/AGENTS.md" <<EOF
# Test Agent with Skills

You are a test agent with GitHub skills enabled.
EOF

    echo "# Running vm0 compose..."
    cd "$TEST_DIR"
    run $CLI_COMMAND compose --yes vm0.yaml
    assert_success

    echo "# Verifying both uploads..."
    assert_output --partial "instructions"
    assert_output --partial "skill"
}

# ============================================
# Run tests (verify files are mounted)
# ============================================

@test "vm0 run with instructions mounts CLAUDE.md file" {
    echo "# Creating config with instructions..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    image: "vm0/claude-code:dev"
    instructions: AGENTS.md
EOF

    echo "# Creating AGENTS.md with unique marker..."
    cat > "$TEST_DIR/AGENTS.md" <<EOF
# Test Instructions

UNIQUE_MARKER_FOR_E2E_TEST_${AGENT_NAME}
EOF

    echo "# Running vm0 compose..."
    cd "$TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Running agent to verify instructions is mounted..."
    # The instructions is mounted at /home/user/.claude/CLAUDE.md
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "cat /home/user/.claude/CLAUDE.md"
    assert_success

    echo "# Verifying output contains the marker from AGENTS.md..."
    assert_output --partial "UNIQUE_MARKER_FOR_E2E_TEST"
}

@test "vm0 run with skills mounts skill directory" {
    echo "# Creating config with skills..."
    # Note: Using base image since github variant may not exist yet
    # Skills work with any image - they're just file mounts
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    image: vm0/claude-code:dev
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
EOF

    echo "# Running vm0 compose..."
    run $CLI_COMMAND compose --yes "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Running agent to verify skill is mounted..."
    # The skill is mounted at /home/user/.claude/skills/github/
    # Provide mock GH_TOKEN since github skill requires it
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        --secrets "GH_TOKEN=mock-token-for-test" \
        "ls /home/user/.claude/skills/github/"
    assert_success

    echo "# Verifying skill directory contains SKILL.md..."
    assert_output --partial "SKILL.md"
}

@test "vm0 run with apps github:dev has gh cli installed" {
    echo "# Creating config with apps: [github:dev]..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    apps:
      - github:dev
EOF

    echo "# Running vm0 compose..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Running agent to verify gh cli is installed..."
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "gh --version"
    assert_success

    echo "# Verifying gh version output..."
    assert_output --partial "gh version"
}

# ============================================
# Validation tests
# ============================================

@test "vm0 compose rejects invalid GitHub URL in skills" {
    echo "# Creating config with invalid skills URL..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    image: "vm0/claude-code:dev"
    skills:
      - https://example.com/not-a-github-url
EOF

    echo "# Running vm0 compose (should fail)..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    assert_output --partial "Invalid skill URL"
}

@test "vm0 compose rejects empty instructions" {
    echo "# Creating config with empty instructions..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    image: "vm0/claude-code:dev"
    instructions: ""
EOF

    echo "# Running vm0 compose (should fail)..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    assert_output --partial "empty"
}

@test "vm0 compose with nonexistent instructions file fails" {
    echo "# Creating config with nonexistent instructions file..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    image: "vm0/claude-code:dev"
    instructions: nonexistent-file.md
EOF

    echo "# Running vm0 compose (should fail)..."
    cd "$TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_failure
}
