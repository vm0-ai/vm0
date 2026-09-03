#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
smoke_script="${repo_root}/.github/scripts/smoke-okou-cli-artifact.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

fixture_bin="${tmp_dir}/bin"
package_path="${tmp_dir}/package.tgz"
mkdir -p "$fixture_bin"
printf 'fixture\n' >"$package_path"

cat >"${fixture_bin}/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "$@"
EOF

cat >"${fixture_bin}/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

while [[ "${1:-}" == --* ]]; do
  shift
done

entrypoint="$1"
shift

echo "npm notice This endpoint is being retired. Use the bulk advisory endpoint instead." >&2
if [[ "${EMIT_UNEXPECTED_STDERR:-false}" == "true" &&
  "$entrypoint" == "okou" && "${1:-}" == "--version" ]]; then
  echo "unexpected CLI stderr" >&2
fi

case "$entrypoint:$*" in
  "okou:--help")
    printf 'Usage: okou\nOkou CLI\n'
    ;;
  "okou:--version")
    echo "1.2.3"
    ;;
  "okou:__agent-loop --help")
    echo "Internal sandbox Pi agent loop"
    ;;
  "okou:__unsupported-command")
    exit 1
    ;;
  "zero:--help")
    echo "unsupported entrypoint" >&2
    exit 1
    ;;
  *)
    echo "unexpected invocation: $entrypoint $*" >&2
    exit 1
    ;;
esac
EOF

chmod +x "${fixture_bin}/node" "${fixture_bin}/npx"

output="$({
  PATH="${fixture_bin}:${PATH}" bash "$smoke_script" "$package_path"
} 2>&1)"
grep -Fq "Smoke-tested the canonical okou CLI and unsupported zero boundary" \
  <<<"$output"

failure_output="${tmp_dir}/failure-output.txt"
if PATH="${fixture_bin}:${PATH}" \
  EMIT_UNEXPECTED_STDERR=true \
  bash "$smoke_script" "$package_path" >"$failure_output" 2>&1; then
  echo "Smoke test unexpectedly ignored non-npm stderr" >&2
  exit 1
fi
grep -Fxq "unexpected CLI stderr" "$failure_output"
grep -Fq "CLI smoke emitted unexpected stderr: okou --version" "$failure_output"

echo "smoke-okou-cli-artifact tests passed"
