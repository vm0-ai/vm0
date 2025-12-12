#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Create temporary test directory for dynamic configs
    export TEST_DIR="$(mktemp -d)"
    # Use unique agent name with timestamp to avoid conflicts
    export AGENT_NAME="e2e-simplified-$(date +%s)"
    export ARTIFACT_NAME="e2e-simplified-artifact-$(date +%s)"
}

teardown() {
    # Clean up temporary directory
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

# ============================================
# Provider auto-configuration tests
# ============================================

@test "vm0 compose with provider auto-config (no explicit image/working_dir)" {
    echo "# Creating simplified config without image and working_dir..."
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

    echo "# Verifying auto-configuration messages..."
    assert_output --partial "Auto-configured image"
    assert_output --partial "Auto-configured working_dir"
    assert_output --partial "Compose created"
}

@test "vm0 compose with explicit image overrides auto-config" {
    echo "# Creating config with explicit image..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with explicit image"
    provider: claude-code
    image: vm0-github-cli-dev
EOF

    echo "# Running vm0 compose..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Verifying only working_dir was auto-configured..."
    refute_output --partial "Auto-configured image"
    assert_output --partial "Auto-configured working_dir"
}

# ============================================
# system_prompt tests
# ============================================

@test "vm0 compose with system_prompt uploads prompt file" {
    echo "# Creating config with system_prompt..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    system_prompt: AGENTS.md
EOF

    echo "# Creating AGENTS.md file..."
    cat > "$TEST_DIR/AGENTS.md" <<EOF
# Test System Prompt

You are a test agent. Always respond with TEST_PROMPT_LOADED.
EOF

    echo "# Running vm0 compose..."
    cd "$TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_success

    echo "# Verifying system prompt upload..."
    assert_output --partial "Uploading system prompt"
    assert_output --partial "System prompt"
}

@test "vm0 compose with system_prompt deduplicates unchanged content" {
    echo "# Creating config with system_prompt..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    system_prompt: AGENTS.md
EOF

    echo "# Creating AGENTS.md file..."
    cat > "$TEST_DIR/AGENTS.md" <<EOF
# Test System Prompt for Deduplication

This content should be deduplicated on second upload.
EOF

    echo "# First compose..."
    cd "$TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_success
    assert_output --partial "System prompt"

    echo "# Second compose with same content..."
    run $CLI_COMMAND compose vm0.yaml
    assert_success
    # Should show unchanged indicator
    assert_output --partial "unchanged"
}

# ============================================
# system_skills tests
# ============================================

@test "vm0 compose with system_skills downloads and uploads skill" {
    echo "# Creating config with system_skills..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    image: vm0-github-cli-dev
    system_skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
EOF

    echo "# Running vm0 compose..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Verifying skill download and upload..."
    assert_output --partial "Uploading"
    assert_output --partial "system skill"
    assert_output --partial "Downloading"
}

@test "vm0 compose with system_skills deduplicates unchanged skill" {
    echo "# Creating config with system_skills..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    image: vm0-github-cli-dev
    system_skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
EOF

    echo "# First compose..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Second compose with same skill..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
    # Should show unchanged indicator for the skill
    assert_output --partial "unchanged"
}

# ============================================
# Combined system_prompt and system_skills tests
# ============================================

@test "vm0 compose with both system_prompt and system_skills" {
    echo "# Creating config with both system_prompt and system_skills..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    image: vm0-github-cli-dev
    system_prompt: AGENTS.md
    system_skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
EOF

    echo "# Creating AGENTS.md file..."
    cat > "$TEST_DIR/AGENTS.md" <<EOF
# Test Agent with Skills

You are a test agent with GitHub skills enabled.
EOF

    echo "# Running vm0 compose..."
    cd "$TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_success

    echo "# Verifying both uploads..."
    assert_output --partial "system prompt"
    assert_output --partial "system skill"
}

# ============================================
# Run tests (verify files are mounted)
# ============================================

@test "vm0 run with system_prompt mounts CLAUDE.md file" {
    echo "# Creating config with system_prompt..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    system_prompt: AGENTS.md
EOF

    echo "# Creating AGENTS.md with unique marker..."
    cat > "$TEST_DIR/AGENTS.md" <<EOF
# Test System Prompt

UNIQUE_MARKER_FOR_E2E_TEST_${AGENT_NAME}
EOF

    echo "# Running vm0 compose..."
    cd "$TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Running agent to verify system_prompt is mounted..."
    # The system_prompt is mounted at /home/user/.config/claude/CLAUDE.md
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "cat /home/user/.config/claude/CLAUDE.md"
    assert_success

    echo "# Verifying output contains the marker from AGENTS.md..."
    assert_output --partial "UNIQUE_MARKER_FOR_E2E_TEST"
}

@test "vm0 run with system_skills mounts skill directory" {
    echo "# Creating config with system_skills..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    image: vm0-github-cli-dev
    system_skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/github
EOF

    echo "# Running vm0 compose..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    echo "# Initializing artifact storage..."
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    echo "# Running agent to verify system_skill is mounted..."
    # The system_skill is mounted at /home/user/.config/claude/skills/github/
    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "ls /home/user/.config/claude/skills/github/"
    assert_success

    echo "# Verifying skill directory contains SKILL.md..."
    assert_output --partial "SKILL.md"
}

# ============================================
# Validation tests
# ============================================

@test "vm0 compose rejects invalid GitHub URL in system_skills" {
    echo "# Creating config with invalid system_skills URL..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    system_skills:
      - https://example.com/not-a-github-url
EOF

    echo "# Running vm0 compose (should fail)..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    assert_output --partial "Invalid system_skill URL"
}

@test "vm0 compose rejects empty system_prompt" {
    echo "# Creating config with empty system_prompt..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    system_prompt: ""
EOF

    echo "# Running vm0 compose (should fail)..."
    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_failure
    assert_output --partial "empty"
}

@test "vm0 compose with nonexistent system_prompt file fails" {
    echo "# Creating config with nonexistent system_prompt file..."
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    system_prompt: nonexistent-file.md
EOF

    echo "# Running vm0 compose (should fail)..."
    cd "$TEST_DIR"
    run $CLI_COMMAND compose vm0.yaml
    assert_failure
}
