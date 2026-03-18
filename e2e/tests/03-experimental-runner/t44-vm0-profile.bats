#!/usr/bin/env bats

# Test VM0 profile support (E2E happy path only)
# This test verifies that:
# 1. vm0 compose accepts experimental_profile field
# 2. vm0 run with browser profile boots a VM with Chromium + agent-browser
#
# Note: Profile validation (org/name format) is tested via Rust unit tests.

load '../../helpers/setup'

setup() {
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-profile-$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-profile-art-$(date +%s%3N)-$RANDOM"
}

teardown() {
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

@test "vm0 compose with experimental_profile succeeds" {
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with browser profile"
    framework: claude-code
    experimental_profile: vm0/browser
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
    assert_output --partial "Compose"
}

@test "vm0 run with browser profile has agent-browser installed" {
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with browser profile"
    framework: claude-code
    experimental_profile: vm0/browser
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "agent-browser --version"
    assert_success
    assert_output --partial "agent-browser"
}

@test "vm0 run with browser profile has chromium available" {
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    description: "Test agent with browser profile"
    framework: claude-code
    experimental_profile: vm0/browser
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success

    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    run $CLI_COMMAND artifact push
    assert_success

    run $CLI_COMMAND run "$AGENT_NAME" \
        --artifact-name "$ARTIFACT_NAME" \
        "which chromium || which chrome || which google-chrome || ls /root/.cache/puppeteer/chrome/*/chrome-linux64/chrome"
    assert_success
}
