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
        $ZERO_CLI agent delete "$(cat "$name_file")" --yes 2>/dev/null || true
        rm -f "$name_file"
    fi
}

# ============================================================================
# Happy Path Tests
# ============================================================================

@test "zero agent create creates agent" {
    # Retry up to 3 times with 3s backoff because the API returns 422 when
    # skill cache is not yet warm ("Please try again later").
    # BATS_TEST_TIMEOUT is 30s, so budget: 3 attempts * ~2s call + 2 * 3s sleep = ~12s
    local max_attempts=3
    for ((attempt=1; attempt<=max_attempts; attempt++)); do
        run $ZERO_CLI agent create --connectors github --display-name "E2E Test Agent" --description "Created by E2E test"
        if [[ "$status" -eq 0 ]]; then
            break
        fi
        # If the error is skill-cache related, retry; otherwise fail immediately
        if [[ "$output" == *"not cached"* ]] && ((attempt < max_attempts)); then
            echo "# Attempt $attempt: skill cache not ready, retrying in 3s..." >&3
            sleep 3
        else
            break
        fi
    done
    assert_success
    assert_output --partial "created"

    name=$(echo "$output" | grep -oP "agent '\K[^']+")
    echo "$name" > "$(agent_name_file)"
}

@test "zero agent list shows created agent" {
    [ -f "$(agent_name_file)" ] || skip "agent not created"

    run $ZERO_CLI agent list
    assert_success
    assert_output --partial "E2E Test Agent"
    assert_output --partial "github"
}

@test "zero agent view shows agent details" {
    [ -f "$(agent_name_file)" ] || skip "agent not created"
    name=$(cat "$(agent_name_file)")

    run $ZERO_CLI agent view "$name"
    assert_success
    assert_output --partial "$name"
    assert_output --partial "Connectors:"
    assert_output --partial "Description:"
}

@test "zero agent edit updates agent" {
    [ -f "$(agent_name_file)" ] || skip "agent not created"
    name=$(cat "$(agent_name_file)")

    run $ZERO_CLI agent edit "$name" --display-name "Updated E2E Agent"
    assert_success
    assert_output --partial "updated"
}

@test "zero agent view shows updated agent" {
    [ -f "$(agent_name_file)" ] || skip "agent not created"
    name=$(cat "$(agent_name_file)")

    run $ZERO_CLI agent view "$name"
    assert_success
    assert_output --partial "Updated E2E Agent"
}

@test "zero agent delete removes agent" {
    [ -f "$(agent_name_file)" ] || skip "agent not created"
    name=$(cat "$(agent_name_file)")

    run $ZERO_CLI agent delete "$name" --yes
    assert_success
    assert_output --partial "deleted"
}

@test "zero agent list excludes deleted agent" {
    [ -f "$(agent_name_file)" ] || skip "agent not created"

    run $ZERO_CLI agent list
    assert_success
    refute_output --partial "Updated E2E Agent"
}
