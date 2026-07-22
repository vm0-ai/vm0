#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PLAN="${SCRIPT_DIR}/runner-binary-cache-plan.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local output=$1 expected=$2
  grep -qF "$expected" <<<"$output" || fail "expected '${expected}' in: ${output}"
}

command -v zstd >/dev/null || fail "zstd is required"

arm_target=aarch64-unknown-linux-musl
x86_target=x86_64-unknown-linux-musl
arm_digest=$("${SCRIPT_DIR}/runner-binary-build/digest.sh" "$arm_target" | sed -n 's/^binary-input-digest=//p')
x86_digest=$("${SCRIPT_DIR}/runner-binary-build/digest.sh" "$x86_target" | sed -n 's/^binary-input-digest=//p')
arm_artifact="runner-binary-asset-${arm_target}-${arm_digest}"
x86_artifact="runner-binary-asset-${x86_target}-${x86_digest}"
matrix=$(jq -cn \
  --arg arm_target "$arm_target" \
  --arg x86_target "$x86_target" '[
    {
      id: "arm64", label: "arm64", target: $arm_target, unameM: "aarch64",
      cacheSuffix: "arm64", assetSuffix: "arm64"
    },
    {
      id: "x86_64", label: "x86_64", target: $x86_target, unameM: "x86_64",
      cacheSuffix: "x86_64", assetSuffix: "x86_64"
    }
  ]')

. "${SCRIPT_DIR}/runner-guest-binaries.sh"
. "${REPO_ROOT}/.github/scripts/runner-binary-build/contract.env"
runner_guest_binaries_load
guest_json='{}'
for guest in "${RUNNER_GUEST_BINARIES[@]}"; do
  guest_sha=$(printf '%s' "$guest" | sha256sum | awk '{print $1}')
  guest_json=$(jq -c --arg guest "$guest" --arg sha "$guest_sha" '. + {($guest): $sha}' <<<"$guest_json")
done

mkdir -p "${TMPDIR}/bin" "${TMPDIR}/fixtures" "${TMPDIR}/objects" "${TMPDIR}/runner-temp"
runner="${TMPDIR}/runner"
printf 'runner binary cache plan fixture\n' > "$runner"
runner_sha=$(sha256sum "$runner" | awk '{print $1}')
runner_size=$(stat -c '%s' "$runner")
main_head=$(printf 'b%.0s' {1..40})

create_fixture() {
  local target=$1 digest=$2 name=$3
  local object="${TMPDIR}/objects/${target}.zst"
  zstd -q -3 -f -o "$object" "$runner"
  object_size=$(stat -c '%s' "$object")
  jq -n \
    --arg digest "$digest" \
    --arg target "$target" \
    --arg toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" \
    --arg runner_sha "$runner_sha" \
    --argjson runner_size "$runner_size" \
    --argjson guests "$guest_json" \
    --arg object_key "runner-binaries/${target}/${runner_sha}.zst" \
    --argjson object_size "$object_size" \
    --arg head "$main_head" '
      {
        schemaVersion: 1,
        binaryInputDigest: $digest,
        target: $target,
        toolchainImage: $toolchain,
        runner: {sha256: $runner_sha, sizeBytes: $runner_size},
        guests: $guests,
        object: {key: $object_key, compression: "zstd", sizeBytes: $object_size},
        producer: {
          repository: "vm0-ai/vm0",
          workflowPath: ".github/workflows/runner-image.yml",
          runId: 20,
          runAttempt: 1,
          event: "push",
          headSha: $head,
          prNumber: null
        },
        createdAt: "2026-07-22T00:00:00Z"
      }
    ' > "${TMPDIR}/fixtures/${name}.json"
}

create_fixture "$arm_target" "$arm_digest" "$arm_artifact"
create_fixture "$x86_target" "$x86_digest" "$x86_artifact"

cat > "${TMPDIR}/fixtures/run-20.json" <<JSON
{"id":20,"run_attempt":1,"event":"push","status":"completed","conclusion":"success","head_branch":"main","head_sha":"${main_head}","path":".github/workflows/runner-image.yml","repository":{"full_name":"vm0-ai/vm0"},"pull_requests":[]}
JSON

cat > "${TMPDIR}/bin/gh" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_LOG"
if [ "$1" = "api" ]; then
  endpoint="${*: -1}"
  if [[ "$endpoint" == *'/actions/artifacts?'* ]]; then
    name=${endpoint#*name=}
    name=${name%%&*}
    if [ "${GH_SCENARIO:-all-hit}" = "all-miss" ] ||
      { [ "${GH_SCENARIO:-all-hit}" = "mixed" ] && [ "$name" = "$X86_ARTIFACT" ]; }; then
      printf '[{"artifacts":[]}]\n'
    else
      printf '[{"artifacts":[{"id":120,"name":"%s","expired":false,"size_in_bytes":1000,"created_at":"2026-07-22T00:00:00Z","workflow_run":{"id":20,"head_branch":"main","head_sha":"%s"}}]}]\n' \
        "$name" "$MAIN_HEAD"
    fi
    exit 0
  fi
  cp "${FIXTURES}/run-20.json" /dev/stdout
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
  artifact_name=""
  output_dir=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -n) artifact_name=$2; shift 2 ;;
      -D) output_dir=$2; shift 2 ;;
      *) shift ;;
    esac
  done
  mkdir -p "$output_dir"
  cp "${FIXTURES}/${artifact_name}.json" "${output_dir}/manifest.json"
  exit 0
fi
exit 2
BASH
chmod +x "${TMPDIR}/bin/gh"

cat > "${TMPDIR}/bin/aws" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
[ "$1" = "s3api" ] || exit 2
operation=$2
shift 2
key=""
destination=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --key) key=$2; shift 2 ;;
    --endpoint-url|--bucket|--output|--range|--cli-connect-timeout|--cli-read-timeout) shift 2 ;;
    --*) shift ;;
    *) destination=$1; shift ;;
  esac
done
target=${key#runner-binaries/}
target=${target%%/*}
object="${OBJECTS}/${target}.zst"
case "$operation" in
  head-object) printf '{"ContentLength":%s}\n' "$(stat -c '%s' "$object")" ;;
  get-object) cp "$object" "$destination"; printf '{}\n' ;;
  *) exit 2 ;;
esac
BASH
chmod +x "${TMPDIR}/bin/aws"

run_plan() {
  local scenario=$1 output_dir=$2 event=${3:-pull_request}
  local pr_number=123 pr_head_ref=feature
  if [ "$event" = "push" ]; then
    pr_number=""
    pr_head_ref=""
  fi
  PATH="${TMPDIR}/bin:${PATH}" \
  GH_LOG="${TMPDIR}/gh.log" \
  GH_SCENARIO="$scenario" \
  FIXTURES="${TMPDIR}/fixtures" \
  OBJECTS="${TMPDIR}/objects" \
  ARM_ARTIFACT="$arm_artifact" \
  X86_ARTIFACT="$x86_artifact" \
  MAIN_HEAD="$main_head" \
  AWS_ACCESS_KEY_ID=test-access \
  AWS_SECRET_ACCESS_KEY=test-secret \
  R2_ACCOUNT_ID=test-account \
  R2_BUCKET_NAME=test-bucket \
  RUNNER_TEMP="${TMPDIR}/runner-temp" \
  REPO=vm0-ai/vm0 \
  CURRENT_RUN_ID=99 \
  CURRENT_EVENT="$event" \
  CURRENT_PR_NUMBER="$pr_number" \
  CURRENT_PR_HEAD_REF="$pr_head_ref" \
  DEFAULT_BRANCH=main \
  RUNNER_HOST_GROUPS_MATRIX="$matrix" \
  RESOLVE_OUTPUT_DIR="$output_dir" \
    "$PLAN"
}

: > "${TMPDIR}/gh.log"
all_hit=$(run_plan all-hit "${TMPDIR}/all-hit")
assert_contains "$all_hit" 'compile-matrix=[]'
assert_contains "$all_hit" 'hit-count=2'
assert_contains "$all_hit" 'miss-count=0'
cmp -s "$runner" "${TMPDIR}/all-hit/${arm_target}/runner" || fail "arm hit bytes were not staged"
cmp -s "$runner" "${TMPDIR}/all-hit/${x86_target}/runner" || fail "x86 hit bytes were not staged"

mixed=$(run_plan mixed "${TMPDIR}/mixed")
assert_contains "$mixed" 'hit-count=1'
assert_contains "$mixed" 'miss-count=1'
mixed_matrix=$(sed -n 's/^compile-matrix=//p' <<<"$mixed")
[ "$(jq -r '.[0].target' <<<"$mixed_matrix")" = "$x86_target" ] || fail "mixed plan must compile x86 only"
[ -f "${TMPDIR}/mixed/${arm_target}/runner" ] || fail "mixed plan must stage the arm hit"
[ ! -e "${TMPDIR}/mixed/${x86_target}" ] || fail "mixed plan must not stage a missed target"

all_miss=$(run_plan all-miss "${TMPDIR}/all-miss")
assert_contains "$all_miss" 'hit-count=0'
assert_contains "$all_miss" 'miss-count=2'
all_miss_matrix=$(sed -n 's/^compile-matrix=//p' <<<"$all_miss")
[ "$(jq 'length' <<<"$all_miss_matrix")" -eq 2 ] || fail "all-miss plan must compile both targets"

: > "${TMPDIR}/gh.log"
forced=$(RUNNER_BINARY_CACHE_FORCE_MISS=true run_plan all-hit "${TMPDIR}/forced")
assert_contains "$forced" 'hit-count=0'
assert_contains "$forced" 'miss-count=2'
assert_contains "$forced" '"reason":"force-miss"'
[ ! -s "${TMPDIR}/gh.log" ] || fail "force-miss plan must not query GitHub"

: > "${TMPDIR}/gh.log"
main=$(run_plan all-hit "${TMPDIR}/main" push)
assert_contains "$main" 'hit-count=0'
assert_contains "$main" 'miss-count=2'
assert_contains "$main" '"reason":"protected-main-full-build"'
[ ! -s "${TMPDIR}/gh.log" ] || fail "protected-main plan must not query GitHub"

mkdir -p "${TMPDIR}/timeout-bin"
cat > "${TMPDIR}/timeout-bin/timeout" <<'BASH'
#!/usr/bin/env bash
exit "${TIMEOUT_STATUS:-124}"
BASH
chmod +x "${TMPDIR}/timeout-bin/timeout"
timed_out=$(PATH="${TMPDIR}/timeout-bin:${TMPDIR}/bin:${PATH}" \
  GH_LOG="${TMPDIR}/gh.log" \
  RUNNER_HOST_GROUPS_MATRIX="$matrix" \
  RESOLVE_OUTPUT_DIR="${TMPDIR}/timed-out" \
  REPO=vm0-ai/vm0 \
  CURRENT_RUN_ID=99 \
  CURRENT_EVENT=pull_request \
  CURRENT_PR_NUMBER=123 \
  CURRENT_PR_HEAD_REF=feature \
  DEFAULT_BRANCH=main \
  "$PLAN")
assert_contains "$timed_out" 'hit-count=0'
assert_contains "$timed_out" 'miss-count=2'
assert_contains "$timed_out" '"reason":"resolve-timeout"'

killed=$(TIMEOUT_STATUS=137 \
  PATH="${TMPDIR}/timeout-bin:${TMPDIR}/bin:${PATH}" \
  GH_LOG="${TMPDIR}/gh.log" \
  RUNNER_HOST_GROUPS_MATRIX="$matrix" \
  RESOLVE_OUTPUT_DIR="${TMPDIR}/killed" \
  REPO=vm0-ai/vm0 \
  CURRENT_RUN_ID=99 \
  CURRENT_EVENT=pull_request \
  CURRENT_PR_NUMBER=123 \
  CURRENT_PR_HEAD_REF=feature \
  DEFAULT_BRANCH=main \
  "$PLAN")
assert_contains "$killed" 'hit-count=0'
assert_contains "$killed" 'miss-count=2'
assert_contains "$killed" '"reason":"resolve-timeout"'

echo "runner-binary-cache-plan-test: ok"
