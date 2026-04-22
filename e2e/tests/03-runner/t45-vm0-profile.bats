#!/usr/bin/env bats

# Test VM0 profile support (E2E happy path only)
# Verifies that the default profile includes CLI tools and browser automation.
# Profile validation (org/name format) is tested via Rust unit tests.

load '../../helpers/setup'

setup() {
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-profile-$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-profile-art-$(date +%s%3N)-$RANDOM"
}

teardown() {
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

@test "vm0 run with default profile has claude and gh cli" {
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with default profile"
    framework: claude-code
    experimental_profile: vm0/default
EOF

    run $VM0_CLI compose "$TEST_DIR/vm0.yaml"
    assert_success

    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $VM0_CLI artifact push
    assert_success

    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "claude --version && gh --version"
    assert_success
    assert_output --partial "claude"
    assert_output --partial "gh version"
}

@test "vm0 run with default profile has agent-browser and chromium" {
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with browser automation"
    framework: claude-code
    experimental_profile: vm0/default
EOF

    run $VM0_CLI compose "$TEST_DIR/vm0.yaml"
    assert_success

    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $VM0_CLI artifact push
    assert_success

    run $VM0_CLI run "$AGENT_NAME" \
        --artifact "$ARTIFACT_NAME:/home/user/workspace" \
        "agent-browser open https://github.com && agent-browser get title && agent-browser close"
    assert_success
    assert_output --partial "GitHub"
}
