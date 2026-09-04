#!/usr/bin/env bash

set -euo pipefail

repo_root="${1:-$(git rev-parse --show-toplevel)}"
matches_file="$(mktemp)"
legacy_argv_file="$(mktemp)"
trap 'rm -f -- "${matches_file}" "${legacy_argv_file}"' EXIT

command_pattern='(^|[^[:alnum:]_])zero[[:space:]]+(--help|--version|__agent-loop|agent|workflow|goal|connector|mcp|mail|credit|upgrade|doctor|model|model-provider|logs|search|chat|resource|github|slack|feishu|teams|telegram|phone|whoami|developer-support|computer-use|browser|intro|generate|web|video|host|maps|weather|scrape|people-search|web-search|recognize|translate|finance|seo|banking|local-agent|local-browser|secret|variable|schedule|automation)([^[:alnum:]_-]|$)'
standalone_entrypoint_pattern='(^|[[:space:]])assert_clean_success[[:space:]]+zero([[:space:]]|$)|^[[:space:]]*zero[[:space:]]*\\[[:space:]]*(#.*)?$'

scan_repo_files() {
  (
    cd "${repo_root}"
    git ls-files -z --cached --others --exclude-standard | \
      xargs -0 bash -c "
        status=0
        rg \"\$@\" || status=\$?
        if [[ \"\${status}\" -eq 1 ]]; then
          exit 0
        fi
        exit \"\${status}\"
      " bash "$@"
  )
}

grep_status=0
scan_repo_files -n -I --with-filename --no-heading --color never \
  -e "${command_pattern}" \
  -e "${standalone_entrypoint_pattern}" -- \
  >"${matches_file}" || grep_status=$?

if [[ "${grep_status}" -ne 0 ]]; then
  echo "okou cutover audit could not scan ${repo_root}" >&2
  exit "${grep_status}"
fi

argv_status=0
scan_repo_files -U -l --color never -e '"node",[[:space:]]*"zero"' -- \
  >"${legacy_argv_file}" || argv_status=$?

if [[ "${argv_status}" -ne 0 ]]; then
  echo "okou cutover audit could not scan command-boundary argv" >&2
  exit "${argv_status}"
fi

internal_count=0
historical_count=0
unsupported_user_owned_count=0
unclassified_count=0

while IFS=: read -r file line content; do
  [[ -n "${file}" ]] || continue

  # The Desktop release workflow passes the Zero product identity as a
  # function argument. It is not a CLI entry point and Desktop identity is an
  # explicit non-goal of this cutover.
  if [[ "${file}" == ".github/workflows/release-please.yml" && "${content}" == "            zero \\" ]]; then
    continue
  fi

  category=""
  case "${file}" in
    */CHANGELOG.md | \
      turbo/apps/api/src/signals/routes/test-user-config-state.ts)
      category="historical"
      historical_count=$((historical_count + 1))
      ;;
  esac

  if [[ -z "${category}" && "${content}" == *"okou-cutover-audit: historical"* ]]; then
    category="historical"
    historical_count=$((historical_count + 1))
  fi

  if [[ -z "${category}" && "${content}" == *"okou-cutover-audit: unsupported-user-owned"* ]]; then
    category="unsupported-user-owned"
    unsupported_user_owned_count=$((unsupported_user_owned_count + 1))
  fi

  if [[ -z "${category}" && "${content}" =~ /zero[[:space:]]+model ]]; then
    category="approved-internal-protocol"
    internal_count=$((internal_count + 1))
  fi

  if [[ -z "${category}" && "${content}" =~ zero[[:space:]]+agent(s)?([[:punct:]]|[[:space:]]+(lifecycle|version|events|compose|composes|after|is|not|instructions|onboarding|request|by|metadata|draft|id|and)([^[:alnum:]_-]|$)) ]]; then
    category="approved-internal-protocol"
    internal_count=$((internal_count + 1))
  fi

  if [[ -z "${category}" ]]; then
    category="unclassified"
    unclassified_count=$((unclassified_count + 1))
  fi

  printf '%s %s:%s\n' "${category}" "${file}" "${line}"
done <"${matches_file}"

while IFS= read -r file; do
  [[ -n "${file}" ]] || continue
  printf 'unclassified %s:legacy-node-zero-argv\n' "${file}"
  unclassified_count=$((unclassified_count + 1))
done <"${legacy_argv_file}"

report_boundary_failure() {
  local file="$1"
  local detail="$2"
  printf 'unclassified %s:%s\n' "${file}" "${detail}"
  unclassified_count=$((unclassified_count + 1))
}

cli_package_path="turbo/apps/cli/package.json"
if [[ -f "${repo_root}/${cli_package_path}" ]] &&
  ! jq -e '
    .bin == {okou: "./dist/okou.js"}
    and (.scripts.postbuild | type == "string")
    and ((.scripts.postbuild | contains("zero")) | not)
  ' "${repo_root}/${cli_package_path}" >/dev/null; then
  report_boundary_failure "${cli_package_path}" "legacy executable export or packed metadata"
fi

cli_entrypoint_path="turbo/apps/cli/src/okou.ts"
if [[ -f "${repo_root}/${cli_entrypoint_path}" ]] &&
  rg -q 'endsWith\("zero(\.js|\.ts)?"\)' "${repo_root}/${cli_entrypoint_path}"; then
  report_boundary_failure "${cli_entrypoint_path}" "legacy executable path detection"
fi

artifact_verifier_path=".github/scripts/verify-okou-cli-artifact.sh"
if [[ -f "${repo_root}/${artifact_verifier_path}" ]] &&
  (! rg -q -F 'and ((.bin | keys) == ["okou"])' "${repo_root}/${artifact_verifier_path}" ||
    ! rg -q -F "grep -Fxq 'package/zero.js'" "${repo_root}/${artifact_verifier_path}"); then
  report_boundary_failure "${artifact_verifier_path}" "single-bin or no-zero.js invariant missing"
fi

artifact_smoke_path=".github/scripts/smoke-okou-cli-artifact.sh"
if [[ -f "${repo_root}/${artifact_smoke_path}" ]] &&
  (! rg -q -F 'assert_clean_success okou okou-help --help' "${repo_root}/${artifact_smoke_path}" ||
    ! rg -q -F 'assert_clean_success okou okou-agent-loop-help __agent-loop --help' "${repo_root}/${artifact_smoke_path}" ||
    ! rg -q -F 'assert_unsupported_entrypoint zero zero-help --help' "${repo_root}/${artifact_smoke_path}" ||
    rg -q 'assert_clean_success[[:space:]]+zero([[:space:]]|$)' "${repo_root}/${artifact_smoke_path}"); then
  report_boundary_failure "${artifact_smoke_path}" "canonical success or legacy rejection boundary missing"
fi

local_deploy_test_path=".github/scripts/tests/deploy-cli-local-test.sh"
if [[ -f "${repo_root}/${local_deploy_test_path}" ]] &&
  ! rg -q -F 'and ((.bin | keys) == ["okou"])' "${repo_root}/${local_deploy_test_path}"; then
  report_boundary_failure "${local_deploy_test_path}" "single-bin package assertion missing"
fi

turbo_workflow_path=".github/workflows/turbo.yml"
if [[ -f "${repo_root}/${turbo_workflow_path}" ]] &&
  (rg -q -F '"$node_prefix/bin/zero"' "${repo_root}/${turbo_workflow_path}" ||
    ! rg -q -F 'okou __agent-loop --help' "${repo_root}/${turbo_workflow_path}"); then
  report_boundary_failure "${turbo_workflow_path}" "legacy symlink present or canonical loop smoke missing"
fi

e2e_trace_path="e2e/helpers/trace-cli.sh"
if [[ -f "${repo_root}/${e2e_trace_path}" ]] &&
  (! rg -q -F 'CLI_ENTRYPOINT="okou"' "${repo_root}/${e2e_trace_path}" ||
    rg -q -F '<okou|zero>' "${repo_root}/${e2e_trace_path}"); then
  report_boundary_failure "${e2e_trace_path}" "legacy entry-point selection"
fi

guest_agent_path="crates/guest-agent/src/cli/mod.rs"
if rg -q -F '"zero".to_string()' "${repo_root}/${guest_agent_path}"; then
  echo "unclassified ${guest_agent_path}: guest-agent still invokes zero" >&2
  unclassified_count=$((unclassified_count + 1))
fi
if ! rg -q -F '"okou".to_string()' "${repo_root}/${guest_agent_path}"; then
  echo "unclassified ${guest_agent_path}: canonical okou invocation is missing" >&2
  unclassified_count=$((unclassified_count + 1))
fi

printf 'summary approved-internal-protocol=%s historical=%s unsupported-user-owned=%s unclassified=%s\n' \
  "${internal_count}" \
  "${historical_count}" \
  "${unsupported_user_owned_count}" \
  "${unclassified_count}"

if [[ "${unclassified_count}" -ne 0 ]]; then
  echo "okou cutover audit found unclassified zero command references" >&2
  exit 1
fi
