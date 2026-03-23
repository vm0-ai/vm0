#!/usr/bin/env bats

# Test VM0 zero agent commands (happy path)
#
# This test covers issue #6216: zero agent CLI E2E tests
# Tests the full CRUD lifecycle: create -> list -> view -> edit -> view -> delete -> list
#
# Test Structure:
# - State is shared via $BATS_FILE_TMPDIR (AP-6 compliant)
# - Tests run serially with skip guards for cascading failure prevention

load '../../helpers/setup'

agent_name_file() {
    echo "$BATS_FILE_TMPDIR/agent-name"
}

teardown_file() {
    local name_file
    name_file="$(agent_name_file)"
    if [ -f "$name_file" ]; then
        $CLI_COMMAND zero agent delete "$(cat "$name_file")" --yes 2>/dev/null || true
        rm -f "$name_file"
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
    echo "$name" > "$(agent_name_file)"
}

@test "vm0 zero agent list shows created agent" {
    [ -f "$(agent_name_file)" ] || skip "agent not created"

    run $CLI_COMMAND zero agent list
    assert_success
    assert_output --partial "E2E Test Agent"
    assert_output --partial "github"
}

@test "vm0 zero agent view shows agent details" {
    [ -f "$(agent_name_file)" ] || skip "agent not created"
    name=$(cat "$(agent_name_file)")

    run $CLI_COMMAND zero agent view "$name"
    assert_success
    assert_output --partial "$name"
    assert_output --partial "Connectors:"
    assert_output --partial "Description:"
}

@test "vm0 zero agent edit updates agent" {
    [ -f "$(agent_name_file)" ] || skip "agent not created"
    name=$(cat "$(agent_name_file)")

    run $CLI_COMMAND zero agent edit "$name" --display-name "Updated E2E Agent"
    assert_success
    assert_output --partial "updated"
}

@test "vm0 zero agent view shows updated agent" {
    [ -f "$(agent_name_file)" ] || skip "agent not created"
    name=$(cat "$(agent_name_file)")

    run $CLI_COMMAND zero agent view "$name"
    assert_success
    assert_output --partial "Updated E2E Agent"
}

@test "vm0 zero agent delete removes agent" {
    [ -f "$(agent_name_file)" ] || skip "agent not created"
    name=$(cat "$(agent_name_file)")

    run $CLI_COMMAND zero agent delete "$name" --yes
    assert_success
    assert_output --partial "deleted"
}

@test "vm0 zero agent list excludes deleted agent" {
    [ -f "$(agent_name_file)" ] || skip "agent not created"

    run $CLI_COMMAND zero agent list
    assert_success
    refute_output --partial "Updated E2E Agent"
}
