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
case "$*" in
  "test -x ${BIN_DIR}/runner") ;;
  "sudo ${BIN_DIR}/runner config "*)
    printf '%s\n' "$*" >"${MOCK_REMOTE_ROOT}/${host}/config"
    ;;
  "sudo ${BIN_DIR}/runner service stop "*)
    rm -f "${MOCK_REMOTE_ROOT}/${host}/service"
    ;;
  "sudo rm -f ${RUNNER_DIR}/status.json") ;;
  "sudo ${BIN_DIR}/runner service start "*)
    printf '%s\n' "$*" >"${MOCK_REMOTE_ROOT}/${host}/service"
    ;;
  "sudo ${BIN_DIR}/runner service wait-running "*)
    if [ "${MOCK_FAIL_READINESS:-false}" = true ]; then
      exit 1
    fi
    echo 35
    ;;
  "sudo ${BIN_DIR}/runner doctor "*) ;;
  *) echo "unexpected SSH command: $*" >&2; exit 1 ;;
esac
SH
chmod +x "${tmp_dir}/bin/ssh"

run_case() {
  local case_name=$1 job_ref=$2 selected_host=$3 selected_index=$4 fail_readiness=$5
  local case_dir="${tmp_dir}/${case_name}"
  mkdir -p "$case_dir"
  local host
  for host in arm-1 x86-1 x86-2; do
    mkdir -p "${case_dir}/${host}"
    printf 'existing-service\n' >"${case_dir}/${host}/service"
  done

  local status=0
  env \
    PATH="${tmp_dir}/bin:$PATH" \
    AWS_METAL_RUNNER_HOSTS=arm-1,x86-1,x86-2 \
    BIN_DIR="/var/lib/vm0-runner/bin/${job_ref}" \
    CURRENT_EVENT=pull_request \
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
    RUNNER_GROUP="vm0/development-${job_ref}" \
    RUNNER_SERVICE_REF="$job_ref" \
    RUNNER_SHA_MAP='{"aarch64-unknown-linux-musl":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","x86_64-unknown-linux-musl":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}' \
    SNAPSHOT_HASH_MAP='{"arm-1":"snapshot-arm","x86-1":"snapshot-x86-1","x86-2":"snapshot-x86-2"}' \
    VERCEL_BYPASS=test-bypass \
    MOCK_REMOTE_ROOT="$case_dir" \
    MOCK_SERVICE_LOG="${case_dir}/service.log" \
    MOCK_FAIL_READINESS="$fail_readiness" \
    bash "$script" >"${case_dir}/output" 2>&1 || status=$?

  if [ "$fail_readiness" = true ]; then
    [ "$status" -ne 0 ] || fail "${case_name}: failed readiness must fail deployment"
    [ ! -f "${case_dir}/${selected_host}/service" ] ||
      fail "${case_name}: failed start left the selected service running"
  else
    if [ "$status" -ne 0 ]; then
      cat "${case_dir}/output" >&2
      fail "${case_name}: deployment failed"
    fi
    grep -Fq -- "--name ${job_ref}-${selected_index}" "${case_dir}/${selected_host}/service" ||
      fail "${case_name}: selected service lost its original inventory index"
    grep -Fq -- "--hostname ${selected_host}" "${case_dir}/${selected_host}/config" ||
      fail "${case_name}: config does not use the selected host"
  fi

  [ "$(cut -f1 "${case_dir}/service.log" | sort -u)" = "$selected_host" ] ||
    fail "${case_name}: service operations reached an unselected host"
  [ "$(grep -c 'runner service start ' "${case_dir}/service.log")" -eq 1 ] ||
    fail "${case_name}: deployment must start exactly one service"
  grep -Fq -- "service wait-running --name ${job_ref}-${selected_index}" "${case_dir}/service.log" ||
    fail "${case_name}: readiness must use the selected service identity"
  for host in arm-1 x86-1 x86-2; do
    [ "$host" = "$selected_host" ] && continue
    [ "$(cat "${case_dir}/${host}/service")" = existing-service ] ||
      fail "${case_name}: deployment changed an unselected service"
  done
}

# These image refs select the same hosts as the existing Crates behavior lane.
run_case x86 pr-1 x86-1 2 false
run_case x86-rerun pr-1 x86-1 2 false
run_case arm pr-2 arm-1 1 false
run_case failed-start pr-9 x86-2 3 true

echo "reconcile-and-start-runner-groups-test: ok"
