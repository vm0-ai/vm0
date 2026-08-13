#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

required_env=(
  GH_TOKEN
  GITHUB_REPOSITORY
  GITHUB_RUN_ID
  JOB_REF
  METAL_HOSTS
  METAL_USER
  PR_NUMBER
)
for name in "${required_env[@]}"; do
  require_env "$name"
done

if [[ ! "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
  echo "invalid PR number: ${PR_NUMBER}" >&2
  exit 2
fi
if [ "$JOB_REF" != "pr-${PR_NUMBER}" ]; then
  echo "runner cleanup namespace mismatch: ${JOB_REF} != pr-${PR_NUMBER}" >&2
  exit 2
fi

# The outer barrier normally drains every owner before lock acquisition. This
# second stabilized discovery runs while the host lock is held and aborts
# instead of waiting if approval raced with that first barrier. Aborting lets
# the late owner acquire the lock; a later daily cleanup collects the namespace.
RUNNER_OWNER_ASSERT_IDLE=true \
  RUNNER_OWNER_SCOPE=closed-pr-cleanup \
  "${SCRIPT_DIR}/cancel-superseded-merge-group-runs.sh"

exec ansible-playbook \
  -i "${METAL_HOSTS}," \
  "${REPO_ROOT}/ansible/playbooks/cleanup-turbo-runner.yml" \
  -e "ansible_user=${METAL_USER}" \
  -e "job_ref=${JOB_REF}" \
  -v
