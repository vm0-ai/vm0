#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

digest_value() {
  "$1/.github/runner-binary-build/digest.sh" "$2" \
    | sed -n 's/^binary-input-digest=//p'
}

repo="${TMPDIR}/repo"
mkdir -p "${repo}/.github" "${repo}/crates/runner" "${TMPDIR}/bin"
cp -a "${REPO_ROOT}/.github/runner-binary-build" "${repo}/.github/runner-binary-build"
cat > "${repo}/crates/runner/guest-binaries.json" <<'JSON'
[
  {
    "package": "guest-one",
    "binary": "guest-one",
    "pathEnv": "GUEST_ONE_PATH",
    "bundledEnv": "BUNDLED_GUEST_ONE",
    "destination": "/usr/local/bin/guest-one"
  }
]
JSON
printf '[workspace]\n' > "${repo}/crates/Cargo.toml"
printf 'tracked\n' > "${repo}/crates/input.txt"

git -C "$repo" init -q
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name test
git -C "$repo" add .
git -C "$repo" commit -qm baseline

baseline=$(digest_value "$repo" aarch64-unknown-linux-musl)
[[ "$baseline" =~ ^[0-9a-f]{64}$ ]] || fail "expected a SHA-256 input digest"
x86_digest=$(digest_value "$repo" x86_64-unknown-linux-musl)
[ "$baseline" != "$x86_digest" ] || fail "target must affect the input digest"

printf 'untracked\n' > "${repo}/crates/untracked.txt"
[ "$(digest_value "$repo" aarch64-unknown-linux-musl)" = "$baseline" ] \
  || fail "untracked crates files must not affect the input digest"

cat > "${TMPDIR}/bin/cargo" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_CARGO_LOG"
target=""
profile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) target=$2; shift 2 ;;
    --profile) profile=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$target" ]
[ -n "$profile" ]
mkdir -p "${CARGO_TARGET_DIR}/${target}/${profile}"
printf 'guest-output\n' > "${CARGO_TARGET_DIR}/${target}/${profile}/guest-one"
printf 'runner-output\n' > "${CARGO_TARGET_DIR}/${target}/${profile}/runner"
BASH
chmod +x "${TMPDIR}/bin/cargo"

printf 'exit 99\n' > "${repo}/.github/runner-binary-build/compile.sh"
. "${repo}/.github/runner-binary-build/contract.env"
PATH="${TMPDIR}/bin:${PATH}" \
FAKE_CARGO_LOG="${TMPDIR}/cargo.log" \
TARGET_TRIPLE=aarch64-unknown-linux-musl \
CARGO_TARGET_DIR="${TMPDIR}/target" \
RUNNER_BINARY_CONTEXT_ROOT="${TMPDIR}/runner-binary-build-context-aarch64-unknown-linux-musl" \
RUNNER_BINARY_ACTUAL_TOOLCHAIN_IMAGE="$RUNNER_BINARY_TOOLCHAIN_IMAGE" \
RUNNER_BINARY_METADATA_PATH="${TMPDIR}/metadata.json" \
  "${repo}/.github/runner-binary-build/build.sh" build >/dev/null

[ "$(wc -l < "${TMPDIR}/cargo.log" | tr -d ' ')" -eq 2 ] \
  || fail "expected guest and runner Cargo entry points"
if [ "$(grep -c -- '--locked' "${TMPDIR}/cargo.log")" -ne 2 ]; then
  fail "every Cargo build must use the tracked lockfile"
fi
jq -e \
  --arg digest "$baseline" \
  --arg toolchain "$RUNNER_BINARY_TOOLCHAIN_IMAGE" '
    .schemaVersion == 1 and
    .binaryInputDigest == $digest and
    .toolchainImage == $toolchain and
    .target == "aarch64-unknown-linux-musl" and
    (.guestSha256 | keys) == ["guest-one"] and
    (.runnerSizeBytes > 0)
  ' "${TMPDIR}/metadata.json" >/dev/null \
  || fail "expected fresh metadata from the extracted build contract"
git -C "$repo" restore .github/runner-binary-build/compile.sh

printf 'unrelated\n' > "${repo}/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -qm unrelated
[ "$(digest_value "$repo" aarch64-unknown-linux-musl)" = "$baseline" ] \
  || fail "unrelated tracked paths must not affect the input digest"

printf 'changed\n' >> "${repo}/crates/input.txt"
git -C "$repo" add crates/input.txt
git -C "$repo" commit -qm crates-change
crates_changed=$(digest_value "$repo" aarch64-unknown-linux-musl)
[ "$crates_changed" != "$baseline" ] || fail "crates tree must affect the input digest"

printf '\n' >> "${repo}/.github/runner-binary-build/contract.env"
git -C "$repo" add .github/runner-binary-build/contract.env
git -C "$repo" commit -qm contract-change
contract_changed=$(digest_value "$repo" aarch64-unknown-linux-musl)
[ "$contract_changed" != "$crates_changed" ] || fail "build contract tree must affect the input digest"

context_root="${TMPDIR}/materialized/runner-binary-build-context-aarch64-unknown-linux-musl"
printf 'untracked again\n' > "${repo}/crates/untracked-again.txt"
TARGET_TRIPLE=aarch64-unknown-linux-musl \
RUNNER_BINARY_CONTEXT_ROOT="$context_root" \
  "${repo}/.github/runner-binary-build/build.sh" materialize >/dev/null
[ -f "${context_root}/crates/input.txt" ] || fail "expected tracked crates content"
[ -f "${context_root}/.github/runner-binary-build/compile.sh" ] \
  || fail "expected tracked build contract content"
[ ! -e "${context_root}/crates/untracked-again.txt" ] \
  || fail "materialization must exclude untracked crates content"
[ ! -e "${context_root}/README.md" ] \
  || fail "materialization must exclude unrelated tracked content"

if TARGET_TRIPLE=powerpc-unknown-linux-musl \
  "${repo}/.github/runner-binary-build/build.sh" materialize >/dev/null 2>&1; then
  fail "expected unsupported target to fail"
fi

workflow_toolchain=$(awk '
  /^  build:$/ { in_build = 1; next }
  in_build && /^      image: / { sub(/^      image: /, ""); print; exit }
' "${REPO_ROOT}/.github/workflows/runner-image.yml")
. "${REPO_ROOT}/.github/runner-binary-build/contract.env"
[ "$workflow_toolchain" = "$RUNNER_BINARY_TOOLCHAIN_IMAGE" ] \
  || fail "Runner Image workflow toolchain must match the hashed build contract"

echo "runner-binary-build-test: ok"
