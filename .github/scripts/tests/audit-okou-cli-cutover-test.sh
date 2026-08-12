#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
audit_script="${repo_root}/.github/scripts/audit-okou-cli-cutover.sh"
workflow="${repo_root}/.github/workflows/turbo.yml"

if ! grep -Fq 'run: .github/scripts/audit-okou-cli-cutover.sh' "${workflow}"; then
  echo "Turbo CI does not run the Okou cutover audit" >&2
  exit 1
fi

"${audit_script}" "${repo_root}" >/dev/null

fixture_root="$(mktemp -d)"
trap 'rm -rf -- "${fixture_root}"' EXIT

mkdir -p "${fixture_root}/crates/guest-agent/src/cli"
git -C "${fixture_root}" init -q
git -C "${fixture_root}" config user.email "okou-audit@example.com"
git -C "${fixture_root}" config user.name "Okou audit"

fixture_command="run \`zero workflow list --token DO_NOT_PRINT_THIS\`" # okou-cutover-audit: test-fixture
printf '%s\n' "${fixture_command}" >"${fixture_root}/producer.md"
printf '%s\n' 'let args = vec!["okou".to_string()];' \
  >"${fixture_root}/crates/guest-agent/src/cli/pi_agent_loop.rs"
mkdir -p "${fixture_root}/.github/workflows"
printf '%s\n' "            zero \\" \
  >"${fixture_root}/.github/workflows/release-please.yml"

audit_output="${fixture_root}/audit-output.txt"
if "${audit_script}" "${fixture_root}" >"${audit_output}" 2>&1; then
  echo "audit unexpectedly accepted an unclassified zero command" >&2
  exit 1
fi

grep -Fq 'unclassified producer.md:1' "${audit_output}"
if grep -Fq 'DO_NOT_PRINT_THIS' "${audit_output}"; then
  echo "audit leaked command arguments" >&2
  exit 1
fi

printf '%s\n' 'tracked input that will disappear' >"${fixture_root}/missing-input.md"
git -C "${fixture_root}" add -- missing-input.md
rm -f -- "${fixture_root}/missing-input.md"
if "${audit_script}" "${fixture_root}" >"${audit_output}" 2>&1; then
  echo "audit unexpectedly ignored an rg input error" >&2
  exit 1
fi
grep -Fq 'okou cutover audit could not scan' "${audit_output}"
git -C "${fixture_root}" rm --cached -q -f -- missing-input.md

printf '%s\n' \
  "run \`zero workflow list\` <!-- okou-cutover-audit: test-fixture -->" \
  >"${fixture_root}/producer.md"
"${audit_script}" "${fixture_root}" >/dev/null

legacy_program="$(printf '  \"%s%s\",' ze ro)"
printf '%s\n' 'const argv = ["node",' "${legacy_program}" '  "list",' '];' \
  >"${fixture_root}/argv.ts"
if "${audit_script}" "${fixture_root}" >"${audit_output}" 2>&1; then
  echo "audit unexpectedly accepted a legacy command-boundary argv" >&2
  exit 1
fi
grep -Fq 'unclassified argv.ts:legacy-node-zero-argv' "${audit_output}"
rm -f -- "${fixture_root}/argv.ts"
"${audit_script}" "${fixture_root}" >/dev/null

echo "okou cutover audit tests passed"
