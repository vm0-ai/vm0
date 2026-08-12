#!/usr/bin/env bash

TEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

load "${TEST_ROOT}/test/libs/bats-support/load"
load "${TEST_ROOT}/test/libs/bats-assert/load"

# The wrapper records canonical Okou invocations for CI diagnostics.
export OKOU_CLI="${TEST_ROOT}/helpers/trace-cli.sh"
