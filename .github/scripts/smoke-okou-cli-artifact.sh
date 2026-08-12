#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Usage: $0 <package.tgz>" >&2
  exit 1
fi

package_path="$1"
if [[ ! -f "$package_path" ]]; then
  echo "CLI package does not exist: $package_path" >&2
  exit 1
fi
package_path="$(cd "$(dirname "$package_path")" && pwd -P)/$(basename "$package_path")"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

run_cli() {
  local entrypoint="$1"
  local stdout_file="$2"
  local stderr_file="$3"
  shift 3
  npx --yes --package="$package_path" "$entrypoint" "$@" \
    >"$stdout_file" 2>"$stderr_file"
}

assert_clean_success() {
  local entrypoint="$1"
  local output_name="$2"
  shift 2
  if ! run_cli \
    "$entrypoint" \
    "$tmp_dir/${output_name}.stdout" \
    "$tmp_dir/${output_name}.stderr" \
    "$@"; then
    cat "$tmp_dir/${output_name}.stderr" >&2
    echo "CLI smoke failed: $entrypoint $*" >&2
    exit 1
  fi
  if [[ -s "$tmp_dir/${output_name}.stderr" ]]; then
    cat "$tmp_dir/${output_name}.stderr" >&2
    echo "CLI smoke emitted unexpected stderr: $entrypoint $*" >&2
    exit 1
  fi
}

assert_clean_success okou okou-help --help
assert_clean_success zero zero-help --help # okou-cutover-audit: compatibility-only
cmp "$tmp_dir/okou-help.stdout" "$tmp_dir/zero-help.stdout"
grep -Fq "Usage: okou" "$tmp_dir/okou-help.stdout"
grep -Fq "Okou CLI" "$tmp_dir/okou-help.stdout"

assert_clean_success okou okou-version --version
assert_clean_success zero zero-version --version # okou-cutover-audit: compatibility-only
cmp "$tmp_dir/okou-version.stdout" "$tmp_dir/zero-version.stdout"
grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' "$tmp_dir/okou-version.stdout"

assert_clean_success zero zero-agent-loop-help __agent-loop --help # okou-cutover-audit: compatibility-only
grep -Fq -- "--standby" "$tmp_dir/zero-agent-loop-help.stdout"

okou_error_status=0
run_cli \
  okou \
  "$tmp_dir/okou-error.stdout" \
  "$tmp_dir/okou-error.stderr" \
  __unsupported-command || okou_error_status=$?
zero_error_status=0
run_cli \
  zero \
  "$tmp_dir/zero-error.stdout" \
  "$tmp_dir/zero-error.stderr" \
  __unsupported-command || zero_error_status=$?
if ((okou_error_status == 0 || zero_error_status == 0)); then
  echo "Unsupported CLI command unexpectedly succeeded" >&2
  exit 1
fi
if ((okou_error_status != zero_error_status)); then
  echo "Okou and Zero alias exit codes differ" >&2
  exit 1
fi
cmp "$tmp_dir/okou-error.stdout" "$tmp_dir/zero-error.stdout"
cmp "$tmp_dir/okou-error.stderr" "$tmp_dir/zero-error.stderr"

echo "Smoke-tested canonical okou and temporary zero CLI entry points"
