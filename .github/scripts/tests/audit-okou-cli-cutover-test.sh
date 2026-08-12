#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
audit_script="${repo_root}/.github/scripts/audit-okou-cli-cutover.sh"
security_workflow="${repo_root}/.github/workflows/security.yml"
turbo_workflow="${repo_root}/.github/workflows/turbo.yml"

install_line="$(grep -nF 'sudo apt-get install -y --no-install-recommends ansible-core ripgrep' "${security_workflow}" | cut -d: -f1 || true)"
audit_step_line="$(grep -nF -- '- name: Audit Okou CLI cutover' "${security_workflow}" | cut -d: -f1 || true)"
audit_run_line="$(grep -nF 'run: .github/scripts/audit-okou-cli-cutover.sh' "${security_workflow}" | cut -d: -f1 || true)"
if [[ -z "${install_line}" || -z "${audit_step_line}" || -z "${audit_run_line}" ||
  "${audit_step_line}" -le "${install_line}" || "${audit_run_line}" -le "${audit_step_line}" ]]; then
  echo "Security CI does not run the Okou cutover audit after installing ripgrep" >&2
  exit 1
fi
if grep -Fq 'run: .github/scripts/audit-okou-cli-cutover.sh' "${turbo_workflow}"; then
  echo "Turbo prepare must not run the Okou cutover audit without ripgrep" >&2
  exit 1
fi

"${audit_script}" "${repo_root}" >/dev/null

fixture_root="$(mktemp -d)"
trap 'rm -rf -- "${fixture_root}"' EXIT

mkdir -p "${fixture_root}/crates/guest-agent/src/cli"
git -C "${fixture_root}" init -q
git -C "${fixture_root}" config user.email "okou-audit@example.com"
git -C "${fixture_root}" config user.name "Okou audit"

legacy_entrypoint="$(printf '%s%s' ze ro)"
fixture_command="run \`${legacy_entrypoint} workflow list --token DO_NOT_PRINT_THIS\`"
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
  "run \`${legacy_entrypoint} workflow list\` <!-- okou-cutover-audit: unsupported-user-owned -->" \
  >"${fixture_root}/producer.md"
"${audit_script}" "${fixture_root}" >"${audit_output}"
grep -Fq 'unsupported-user-owned producer.md:1' "${audit_output}"
grep -Fq 'unsupported-user-owned=1 unclassified=0' "${audit_output}"

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

mkdir -p "${fixture_root}/turbo/apps/cli"
printf '%s\n' \
  '{' \
  '  "bin": {' \
  '    "okou": "./dist/okou.js",' \
  "    \"${legacy_entrypoint}\": \"./dist/okou.js\"" \
  '  },' \
  '  "scripts": {' \
  '    "postbuild": "pack both entry points"' \
  '  }' \
  '}' >"${fixture_root}/turbo/apps/cli/package.json"
if "${audit_script}" "${fixture_root}" >"${audit_output}" 2>&1; then
  echo "audit unexpectedly accepted a legacy package export" >&2
  exit 1
fi
grep -Fq 'unclassified turbo/apps/cli/package.json:legacy executable export or packed metadata' \
  "${audit_output}"

echo "okou cutover audit tests passed"
