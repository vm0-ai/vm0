#!/usr/bin/env bats
# Smoke tests for the Okou CLI binary entry points.
# Verifies canonical okou and the temporary zero alias use the same surface.

load '../../helpers/setup'

@test "okou --help identifies Okou and shows supported commands" {
    run $OKOU_CLI --help
    assert_success
    assert_output --partial "Usage: okou"
    assert_output --partial "Okou CLI"
    assert_output --partial "workflow"
    assert_output --partial "agent"
    assert_output --partial "org"
    refute_output --partial "  automation"
    refute_output --partial "  schedule"
    refute_output --partial "  run"
    refute_output --partial "compose"
    refute_output --partial "volume"
    refute_output --partial "artifact"
}

@test "zero --help is identical to canonical okou help" {
    run $OKOU_CLI --help
    assert_success
    local okou_output="$output"

    run $ZERO_CLI --help
    assert_success
    [[ "$output" == "$okou_output" ]]
}

@test "okou and zero output the same version" {
    run $OKOU_CLI --version
    assert_success
    assert_output --regexp '^[0-9]+\.[0-9]+\.[0-9]+'
    local okou_version="$output"

    run $ZERO_CLI --version
    assert_success
    [[ "$output" == "$okou_version" ]]
}

@test "temporary zero can load the internal agent loop" {
    run $ZERO_CLI __agent-loop --help
    assert_success
    assert_output --partial "--standby"
}

@test "okou and zero preserve error output and exit behavior" {
    local command okou_status okou_output
    for command in automation schedule; do
        run $OKOU_CLI "$command" list
        assert_failure
        okou_status="$status"
        okou_output="$output"

        run $ZERO_CLI "$command" list
        assert_failure
        [[ "$status" == "$okou_status" ]]
        [[ "$output" == "$okou_output" ]]
        assert_output --partial "unknown command '$command'"
    done
}
