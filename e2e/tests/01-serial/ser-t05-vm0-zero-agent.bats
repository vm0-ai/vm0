#!/usr/bin/env bats

# Test VM0 zero agent commands (happy path)
#
# This test covers issue #6216: zero agent CLI E2E tests
# Tests the full CRUD lifecycle: create → list → view → edit → view → delete → list

load '../../helpers/setup'

AGENT_NAME_FILE="/tmp/e2e-zero-agent-name"

teardown_file() {
    if [ -f "$AGENT_NAME_FILE" ]; then
        $CLI_COMMAND zero agent delete "$(cat "$AGENT_NAME_FILE")" --yes 2>/dev/null || true
        rm -f "$AGENT_NAME_FILE"
    fi
}

# ============================================================================
# Happy Path Tests
# ============================================================================

@test "vm0 zero agent create creates agent" {
    run $CLI_COMMAND zero agent create --connectors github --display-name "E2E Test Agent" --description "Created by E2E test"
    assert_success
    assert_output --partial "created"

    name=$(echo "$output" | grep -oP "agent '\K[^']+")
    echo "$name" > "$AGENT_NAME_FILE"
}

@test "vm0 zero agent list shows created agent" {
    [ -f "$AGENT_NAME_FILE" ] || skip "agent not created"

    run $CLI_COMMAND zero agent list
    assert_success
    assert_output --partial "E2E Test Agent"
    assert_output --partial "github"
}

@test "vm0 zero agent view shows agent details" {
    [ -f "$AGENT_NAME_FILE" ] || skip "agent not created"
    name=$(cat "$AGENT_NAME_FILE")

    run $CLI_COMMAND zero agent view "$name"
    assert_success
    assert_output --partial "$name"
    assert_output --partial "Connectors:"
    assert_output --partial "Description:"
}

@test "vm0 zero agent edit updates agent" {
    [ -f "$AGENT_NAME_FILE" ] || skip "agent not created"
    name=$(cat "$AGENT_NAME_FILE")

    run $CLI_COMMAND zero agent edit "$name" --display-name "Updated E2E Agent"
    assert_success
    assert_output --partial "updated"
}

@test "vm0 zero agent view shows updated agent" {
    [ -f "$AGENT_NAME_FILE" ] || skip "agent not created"
    name=$(cat "$AGENT_NAME_FILE")

    run $CLI_COMMAND zero agent view "$name"
    assert_success
    assert_output --partial "Updated E2E Agent"
}

@test "vm0 zero agent delete removes agent" {
    [ -f "$AGENT_NAME_FILE" ] || skip "agent not created"
    name=$(cat "$AGENT_NAME_FILE")

    run $CLI_COMMAND zero agent delete "$name" --yes
    assert_success
    assert_output --partial "deleted"
}

@test "vm0 zero agent list excludes deleted agent" {
    [ -f "$AGENT_NAME_FILE" ] || skip "agent not created"

    run $CLI_COMMAND zero agent list
    assert_success
    refute_output --partial "Updated E2E Agent"
}
