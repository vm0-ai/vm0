#!/bin/bash
# Trace wrapper for vm0 CLI in E2E tests.
#
# Logs start/end of each invocation with bats test context, exit code,
# and duration to /tmp/e2e-trace.log. The log file is printed by CI in
# an always-run step so that timeouts leave a trail showing which
# command was last executed and how long completed commands took.
TAG="[${BATS_TEST_FILENAME##*/}] ${BATS_TEST_NAME}"
echo "$(date +%T) $TAG: START vm0 $*" >> /tmp/e2e-trace.log 2>/dev/null
START=$SECONDS
vm0 "$@"
RC=$?
echo "$(date +%T) $TAG: END(${RC}) $((SECONDS - START))s vm0 $*" >> /tmp/e2e-trace.log 2>/dev/null
exit $RC
