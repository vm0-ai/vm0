#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/reconcile-and-start-runner-groups.sh"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "${tmp_dir}/bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

cat >"${tmp_dir}/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "-n" ]; then
  shift
fi
host=${1#*@}
shift
case "$host" in
  arm-1) arch=aarch64; target=aarch64-unknown-linux-musl ;;
  x86-1|x86-2) arch=x86_64; target=x86_64-unknown-linux-musl ;;
  *) echo "unexpected SSH host: $host" >&2; exit 1 ;;
esac

if [ "$*" = "uname -m" ]; then
  echo "$arch"
  exit 0
fi
if [ "$*" = "bash -s -- $BIN_DIR" ]; then
  cat >/dev/null
  jq -r --arg target "$target" '.[$target]' <<<"$RUNNER_SHA_MAP"
  exit 0
fi

printf '%s\t%s\n' "$host" "$*" >>"$MOCK_SERVICE_LOG"
service_name=$(printf '%s\n' "$*" | sed -n "s/.*--name ['\"]*\\([a-z0-9-]*\\).*/\\1/p")
case "$*" in
  "test -x ${BIN_DIR}/runner") ;;
  "sudo ${BIN_DIR}/runner config "*)
    printf '%s\n' "$*" >"${MOCK_REMOTE_ROOT}/${host}/config"
    ;;
  "sudo ${BIN_DIR}/runner service stop "*)
    if [ "${MOCK_FAILURE:-none}" = retire ] && [ "$host" = x86-2 ]; then
      exit 1
    fi
    rm -f "${MOCK_REMOTE_ROOT}/${host}/${service_name}"
    ;;
  "sudo rm -f ${RUNNER_DIR}/status.json") ;;
  "sudo ${BIN_DIR}/runner service start "*)
    printf '%s\n' "$*" >"${MOCK_REMOTE_ROOT}/${host}/${service_name}"
    ;;
  "sudo ${BIN_DIR}/runner service wait-running "*)
    if [ "${MOCK_FAILURE:-none}" = readiness ]; then
      exit 1
    fi
    if [ "${MOCK_FAILURE:-none}" = cancel ]; then
      kill -TERM "$MOCK_DEPLOY_PID"
      exit 0
    fi
    echo 35
    ;;
  "sudo ${BIN_DIR}/runner doctor "*) ;;
  *) echo "unexpected SSH command: $*" >&2; exit 1 ;;
esac
SH
chmod +x "${tmp_dir}/bin/ssh"

cat >"${tmp_dir}/run-deployment" <<'SH'
#!/usr/bin/env bash
export MOCK_DEPLOY_PID=$$
exec bash "$@"
SH

run_case() {
  local case_name=$1 job_ref=$2 selected_host=$3 selected_index=$4 failure=$5
  local case_dir="${tmp_dir}/${case_name}"
  local service_ref=$job_ref current_event=pull_request
  if [[ "$job_ref" == staging-* ]]; then
    service_ref=staging
    current_event=push
  fi
  local host host_index=0
  if [ ! -d "$case_dir" ]; then
    for host in arm-1 x86-1 x86-2; do
      host_index=$((host_index + 1))
      mkdir -p "${case_dir}/${host}"
      printf 'existing-service\n' >"${case_dir}/${host}/${service_ref}-${host_index}"
      printf 'unrelated-service\n' >"${case_dir}/${host}/pr-999-${host_index}"
    done
  fi
  : >"${case_dir}/service.log"

  local status=0
  env \
    PATH="${tmp_dir}/bin:$PATH" \
    AWS_METAL_RUNNER_HOSTS=arm-1,x86-1,x86-2 \
    BIN_DIR="/var/lib/vm0-runner/bin/${job_ref}" \
    CURRENT_EVENT="$current_event" \
    CURRENT_RUN_ID=123 \
    DEFAULT_BRANCH=main \
    JOB_REF="$job_ref" \
    METAL_HOSTS=arm-1,x86-1,x86-2 \
    METAL_USER=ci \
    OFFICIAL_RUNNER_SECRET=test-secret \
    REPO=vm0-ai/vm0 \
    ROOTFS_HASH_MAP='{"arm-1":"rootfs-arm","x86-1":"rootfs-x86-1","x86-2":"rootfs-x86-2"}' \
    RUNNER_API_URL=https://api.example.test \
    RUNNER_DIR="/var/lib/vm0-runner/runners/${job_ref}" \
    RUNNER_GROUP="vm0/development-${service_ref}" \
    RUNNER_SERVICE_REF="$service_ref" \
    RUNNER_SHA_MAP='{"aarch64-unknown-linux-musl":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","x86_64-unknown-linux-musl":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}' \
    SNAPSHOT_HASH_MAP='{"arm-1":"snapshot-arm","x86-1":"snapshot-x86-1","x86-2":"snapshot-x86-2"}' \
    VERCEL_BYPASS=test-bypass \
    MOCK_REMOTE_ROOT="$case_dir" \
    MOCK_SERVICE_LOG="${case_dir}/service.log" \
    MOCK_FAILURE="$failure" \
    bash "${tmp_dir}/run-deployment" "$script" >"${case_dir}/output" 2>&1 || status=$?

  if [ "$failure" != none ]; then
    [ "$status" -ne 0 ] || fail "${case_name}: ${failure} failure must fail deployment"
    if [ "$failure" = cancel ]; then
      [ "$status" -eq 143 ] || fail "${case_name}: cancellation must preserve the signal exit code"
    fi
    [ ! -f "${case_dir}/${selected_host}/${service_ref}-${selected_index}" ] ||
      fail "${case_name}: failed start left the selected service running"
  else
    if [ "$status" -ne 0 ]; then
      cat "${case_dir}/output" >&2
      fail "${case_name}: deployment failed"
    fi
    grep -Fq -- "--name ${service_ref}-${selected_index}" "${case_dir}/${selected_host}/${service_ref}-${selected_index}" ||
      fail "${case_name}: selected service lost its original inventory index"
    grep -Fq -- "--hostname ${selected_host}" "${case_dir}/${selected_host}/config" ||
      fail "${case_name}: config does not use the selected host"
  fi

  [ "$(awk '!/runner service stop / {print $1}' "${case_dir}/service.log" | sort -u)" = "$selected_host" ] ||
    fail "${case_name}: start or readiness operations reached an unselected host"
  [ "$(grep -c 'runner service start ' "${case_dir}/service.log")" -eq 1 ] ||
    fail "${case_name}: deployment must start exactly one service"
  grep -Fq -- "service wait-running --name ${service_ref}-${selected_index}" "${case_dir}/service.log" ||
    fail "${case_name}: readiness must use the selected service identity"
  host_index=0
  for host in arm-1 x86-1 x86-2; do
    host_index=$((host_index + 1))
    [ "$(cat "${case_dir}/${host}/pr-999-${host_index}")" = unrelated-service ] ||
      fail "${case_name}: deployment changed another PR's service"
    [ "$host" = "$selected_host" ] && continue
    # Cancellation can interrupt retirement, but must roll back the new service.
    [ "$failure" = cancel ] && continue
    if [ "$failure" = retire ] && [ "$host" = x86-2 ]; then
      [ -f "${case_dir}/${host}/${service_ref}-${host_index}" ] ||
        fail "${case_name}: fixture did not retain the failed retirement"
    else
      [ ! -f "${case_dir}/${host}/${service_ref}-${host_index}" ] ||
        fail "${case_name}: unselected replica still serves the current namespace"
    fi
  done
}

# These image refs select the same hosts as the existing Crates behavior lane.
run_case x86 pr-1 x86-1 2 none
run_case x86 pr-1 x86-1 2 none
run_case arm pr-2 arm-1 1 none
run_case failed-start pr-9 x86-2 3 readiness
run_case failed-retirement pr-1 x86-1 2 retire
run_case cancelled-start pr-9 x86-2 3 cancel
# A new staging image ref can select another host while service names stay fixed.
run_case staging staging-000000000000 arm-1 1 none
run_case staging staging-222222222222 x86-1 2 none

echo "reconcile-and-start-runner-groups-test: ok"
