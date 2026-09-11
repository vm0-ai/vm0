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
arm_record="runner-binary-asset-${arm_target}-${arm_digest}"
x86_record="runner-binary-asset-${x86_target}-${x86_digest}"
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

create_fixture "$arm_target" "$arm_digest" "$arm_record"
create_fixture "$x86_target" "$x86_digest" "$x86_record"

cat > "${TMPDIR}/fixtures/run-20.json" <<JSON
{"id":20,"run_attempt":1,"event":"push","status":"completed","conclusion":"success","head_branch":"main","head_sha":"${main_head}","path":".github/workflows/runner-image.yml","repository":{"full_name":"vm0-ai/vm0"},"pull_requests":[]}
JSON

mkdir -p "${TMPDIR}/store"
index='[]'
steps='[]'
now=$(date -u +%FT%TZ)
for name in "$arm_record" "$x86_record"; do
  manifest="${TMPDIR}/fixtures/${name}.json"
  sha=$(sha256sum "$manifest" | awk '{print $1}')
  key="runner-ci/v1/vm0-ai/vm0/${name}/20/1/${sha}.json"
  object=$(jq -r '.object.key' "$manifest")
  target=$(jq -r '.target' "$manifest")
  mkdir -p "${TMPDIR}/store/$(dirname "$key")" "${TMPDIR}/store/$(dirname "$object")"
  cp "$manifest" "${TMPDIR}/store/${key}"
  cp "${TMPDIR}/objects/${target}.zst" "${TMPDIR}/store/${object}"
  index=$(jq -c --arg key "$key" --arg time "$now" '. + [{Key:$key,Size:2000,LastModified:$time}]' <<<"$index")
  steps=$(jq -c --arg sha "$sha" --arg time "$now" \
    '. + [{name:("R2 record " + $sha),status:"completed",conclusion:"success",completed_at:$time}]' <<<"$steps")
done
jq -n --argjson steps "$steps" '{jobs:[{id:20,run_id:20,run_attempt:1,name:"Compile",steps:$steps}]}' >"${TMPDIR}/fixtures/jobs-20.json"
cat > "${TMPDIR}/bin/gh" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$GH_LOG"
endpoint="${*: -1}"
if [[ "$endpoint" == *'/jobs?'* ]]; then
  jq -s '.' "${FIXTURES}/jobs-20.json"
else
  cat "${FIXTURES}/run-20.json"
fi
BASH
chmod +x "${TMPDIR}/bin/gh"
ln -s "${SCRIPT_DIR}/tests/fixtures/runner-ci-aws.sh" "${TMPDIR}/bin/aws"

run_plan() {
  local scenario=$1 output_dir=$2 event=${3:-pull_request}
  case "$scenario" in
    all-miss) printf '{"Contents":[]}\n' >"${TMPDIR}/store/index.json" ;;
    mixed) jq -n --argjson index "$index" --arg arm "$arm_record" '{Contents:[$index[] | select(.Key | contains($arm))]}' >"${TMPDIR}/store/index.json" ;;
    all-hit) jq -n --argjson index "$index" '{Contents:$index}' >"${TMPDIR}/store/index.json" ;;
  esac
  local pr_number=123
  if [ "$event" = "push" ]; then
    pr_number=""
  fi
  PATH="${TMPDIR}/bin:${PATH}" \
  GH_LOG="${TMPDIR}/gh.log" \
  GH_SCENARIO="$scenario" \
  FIXTURES="${TMPDIR}/fixtures" \
  AWS_STORE="${TMPDIR}/store" \
  AWS_LOG="${TMPDIR}/aws.log" \
  ARM_RECORD="$arm_record" \
  X86_RECORD="$x86_record" \
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
  DEFAULT_BRANCH=main \
  RUNNER_HOST_GROUPS_MATRIX="$matrix" \
  RESOLVE_OUTPUT_DIR="$output_dir" \
    "$PLAN"
}

: > "${TMPDIR}/gh.log"
plan_output="${TMPDIR}/plan.output"
plan_summary="${TMPDIR}/plan.summary"
all_hit=$(GITHUB_OUTPUT="$plan_output" \
  GITHUB_STEP_SUMMARY="$plan_summary" \
  run_plan all-hit "${TMPDIR}/all-hit")
assert_contains "$all_hit" 'compile-matrix=[]'
assert_contains "$all_hit" 'hit-count=2'
assert_contains "$all_hit" 'miss-count=0'
assert_contains "$all_hit" 'resolution-json=['
plan_output_keys=$(cut -d= -f1 "$plan_output" | LC_ALL=C sort -u | paste -sd, -)
[ "$plan_output_keys" = "compile-matrix,hit-count,hit-targets,miss-count" ] ||
  fail "unexpected plan output keys: ${plan_output_keys}"
grep -qF '### Runner binary cache plan' "$plan_summary" || fail "expected plan summary"
grep -qF "\`${arm_target}\`" "$plan_summary" || fail "expected arm target in plan summary"
grep -qF "\`${x86_target}\`" "$plan_summary" || fail "expected x86 target in plan summary"
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
main_all_hit=$(run_plan all-hit "${TMPDIR}/main-all-hit" push)
assert_contains "$main_all_hit" 'compile-matrix=[]'
assert_contains "$main_all_hit" 'hit-count=2'
assert_contains "$main_all_hit" 'miss-count=0'
assert_contains "$main_all_hit" '"source":"protected-main"'

main_mixed=$(run_plan mixed "${TMPDIR}/main-mixed" push)
assert_contains "$main_mixed" 'hit-count=1'
assert_contains "$main_mixed" 'miss-count=1'
main_mixed_matrix=$(sed -n 's/^compile-matrix=//p' <<<"$main_mixed")
[ "$(jq -r '.[0].target' <<<"$main_mixed_matrix")" = "$x86_target" ] ||
  fail "mixed main plan must compile x86 only"

main_all_miss=$(run_plan all-miss "${TMPDIR}/main-all-miss" push)
assert_contains "$main_all_miss" 'hit-count=0'
assert_contains "$main_all_miss" 'miss-count=2'
main_all_miss_matrix=$(sed -n 's/^compile-matrix=//p' <<<"$main_all_miss")
[ "$(jq 'length' <<<"$main_all_miss_matrix")" -eq 2 ] ||
  fail "all-miss main plan must compile both targets"

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
  DEFAULT_BRANCH=main \
  "$PLAN")
assert_contains "$killed" 'hit-count=0'
assert_contains "$killed" 'miss-count=2'
assert_contains "$killed" '"reason":"resolve-timeout"'

: >"${TMPDIR}/aws.log"
references=$(RUNNER_BINARY_RESOLVE_MODE=reference run_plan all-hit "${TMPDIR}/references")
assert_contains "$references" 'hit-count=2'
assert_contains "$references" 'hit-manifests={'
for target in "$arm_target" "$x86_target"; do
  [ -f "${TMPDIR}/references/${target}/manifest.json" ] || fail "reference plan must carry a per-target manifest"
done
if grep 'get-object' "${TMPDIR}/aws.log" | grep -q 'runner-binaries/'; then
  fail "reference-only planning must not download runner bytes"
fi
echo "runner-binary-cache-plan-test: ok"
