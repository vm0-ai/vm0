#!/usr/bin/env bats

load '../../helpers/setup'

# CLI validation is covered by command integration tests. These runner tests
# retain the deployed preference-to-sandbox boundary using the E2E API helper.

setup_file() {
    local unique_id="$(date +%s%3N)-$RANDOM"
    local agent_name="timezone-e2e-${unique_id}"
    local volume_name="tz-vol-${unique_id}"
    local test_dir="$(mktemp -d)"

    echo "$unique_id" > "$BATS_FILE_TMPDIR/unique_id"
    echo "$agent_name" > "$BATS_FILE_TMPDIR/agent_name"
    echo "$volume_name" > "$BATS_FILE_TMPDIR/volume_name"
    echo "$test_dir" > "$BATS_FILE_TMPDIR/test_dir"

    mkdir -p "$test_dir/$volume_name"
    cd "$test_dir/$volume_name"
    cat > CLAUDE.md << 'VOLEOF'
Test volume for timezone E2E tests.
VOLEOF
    seed_storage_fixture volume "$volume_name" .
    cd "$test_dir"

    cat > "$test_dir/vm0.yaml" <<EOF
version: "1.0"
agents:
  ${agent_name}:
    description: "E2E timezone test agent"
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: ${volume_name}
    version: latest
EOF
    seed_compose_fixture vm0.yaml >/dev/null
}

teardown_file() {
    local test_dir
    test_dir=$(cat "$BATS_FILE_TMPDIR/test_dir" 2>/dev/null || true)
    if [ -n "$test_dir" ] && [ -d "$test_dir" ]; then
        rm -rf "$test_dir"
    fi
}

setup() {
    UNIQUE_ID=$(cat "$BATS_FILE_TMPDIR/unique_id")
    AGENT_NAME=$(cat "$BATS_FILE_TMPDIR/agent_name")
    VOLUME_NAME=$(cat "$BATS_FILE_TMPDIR/volume_name")
    TEST_DIR=$(cat "$BATS_FILE_TMPDIR/test_dir")
    cd "$TEST_DIR"
}

@test "user timezone preference is injected into the sandbox" {
    set_e2e_timezone "Asia/Tokyo"

    run run_compose_fixture "$AGENT_NAME" "echo TZ=\$TZ"
    assert_success
    assert_output --partial "TZ=Asia/Tokyo"
}

@test "explicit TZ overrides the user preference" {
    set_e2e_timezone "Asia/Shanghai"

    local override_agent_name="tz-override-${UNIQUE_ID}"
    cat > "$TEST_DIR/vm0-tz-override.yaml" <<EOF
version: "1.0"
agents:
  ${override_agent_name}:
    description: "Agent with explicit TZ"
    framework: claude-code
    environment:
      TZ: "Europe/London"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: ${VOLUME_NAME}
    version: latest
EOF
    seed_compose_fixture "$TEST_DIR/vm0-tz-override.yaml" >/dev/null

    run run_compose_fixture "$override_agent_name" "echo TZ=\$TZ"
    assert_success
    assert_output --partial "TZ=Europe/London"
}
