#!/usr/bin/env bash

TEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

load "${TEST_ROOT}/test/libs/bats-support/load"
load "${TEST_ROOT}/test/libs/bats-assert/load"

# Supported CLI entry points. The wrapper records invocations for CI diagnostics.
export OKOU_CLI="${TEST_ROOT}/helpers/trace-cli.sh okou"
export ZERO_CLI="${TEST_ROOT}/helpers/trace-cli.sh zero"
