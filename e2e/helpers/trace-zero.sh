#!/bin/bash
# Trace wrapper for zero CLI in E2E tests.
#
# Logs start/end of each invocation with bats test context, exit code,
# and duration to /tmp/e2e-trace.log. The log file is printed by CI in
# an always-run step so that timeouts leave a trail showing which
# command was last executed and how long completed commands took.
#
# Uses GNU timeout to ensure the entire process tree is killed on
# timeout (timeout creates a process group and sends SIGTERM to the
# whole group). CLI_TIMEOUT defaults to 90s, leaving headroom for
# BATS_TEST_TIMEOUT (typically 120s) to handle cleanup.
CLI_TIMEOUT="${CLI_TIMEOUT:-90}"
TAG="[${BATS_TEST_FILENAME##*/}] ${BATS_TEST_NAME}"
echo "$(date +%T) $TAG: START zero $*" >> /tmp/e2e-trace.log 2>/dev/null
START=$SECONDS
timeout --kill-after=5 "$CLI_TIMEOUT" zero "$@"
RC=$?
echo "$(date +%T) $TAG: END(${RC}) $((SECONDS - START))s zero $*" >> /tmp/e2e-trace.log 2>/dev/null
exit $RC
