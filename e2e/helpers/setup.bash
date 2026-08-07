#!/usr/bin/env bash

TEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

load "${TEST_ROOT}/test/libs/bats-support/load"
load "${TEST_ROOT}/test/libs/bats-assert/load"

# Supported CLI entry point. The wrapper records invocations for CI diagnostics.
export ZERO_CLI="${TEST_ROOT}/helpers/trace-zero.sh"
