#!/bin/bash
# Trace wrapper for vm0 CLI in E2E tests.
#
# Logs start/end of each invocation with bats test context, exit code,
# and duration to /tmp/e2e-trace.log. The log file is printed by CI in
# an always-run step so that timeouts leave a trail showing which
# command was last executed and how long completed commands took.
#
# Uses GNU timeout to ensure the entire process tree is killed on
# timeout (timeout creates a process group and sends SIGTERM to the
# whole group). CLI_TIMEOUT stays at 90s unless Bats provides a larger timeout
# budget, then it leaves headroom for setup, diagnostics, and timeout's
# kill-after window.
DEFAULT_CLI_TIMEOUT=90
CLI_TIMEOUT_HEADROOM=20

default_cli_timeout() {
  local bats_timeout="${BATS_TEST_TIMEOUT:-}"
  if [[ "$bats_timeout" =~ ^[0-9]+$ ]] && ((bats_timeout > DEFAULT_CLI_TIMEOUT + CLI_TIMEOUT_HEADROOM)); then
    echo $((bats_timeout - CLI_TIMEOUT_HEADROOM))
    return
  fi
  echo "$DEFAULT_CLI_TIMEOUT"
}

CLI_TIMEOUT="${CLI_TIMEOUT:-$(default_cli_timeout)}"
TAG="[${BATS_TEST_FILENAME##*/}] ${BATS_TEST_NAME}"
echo "$(date +%T) $TAG: START vm0 $*" >> /tmp/e2e-trace.log 2>/dev/null
START=$SECONDS
timeout --kill-after=5 "$CLI_TIMEOUT" vm0 "$@"
RC=$?
echo "$(date +%T) $TAG: END(${RC}) $((SECONDS - START))s vm0 $*" >> /tmp/e2e-trace.log 2>/dev/null
exit $RC
