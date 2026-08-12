#!/usr/bin/env bash

set -euo pipefail

repo_root="${1:-$(git rev-parse --show-toplevel)}"
matches_file="$(mktemp)"
legacy_argv_file="$(mktemp)"
trap 'rm -f -- "${matches_file}" "${legacy_argv_file}"' EXIT

command_pattern='(^|[^[:alnum:]_])zero[[:space:]]+(--help|--version|__agent-loop|agent|workflow|goal|connector|mcp|presentation-template|mail|credit|upgrade|doctor|model|model-provider|logs|search|chat|resource|github|slack|feishu|teams|telegram|phone|whoami|developer-support|computer-use|browser|intro|generate|web|video|host|maps|weather|scrape|people-search|web-search|recognize|translate|finance|seo|banking|local-agent|local-browser|secret|variable|schedule|automation)([^[:alnum:]_-]|$)'
standalone_entrypoint_pattern='(^|[[:space:]])assert_clean_success[[:space:]]+zero([[:space:]]|$)|^[[:space:]]*zero[[:space:]]*\\[[:space:]]*(#.*)?$'

grep_status=0
(
  cd "${repo_root}"
  git ls-files -z --cached --others --exclude-standard | \
    xargs -0 rg -n -I --with-filename --no-heading --color never \
      -e "${command_pattern}" \
      -e "${standalone_entrypoint_pattern}" --
) >"${matches_file}" || grep_status=$?

if [[ "${grep_status}" -gt 1 ]]; then
  echo "okou cutover audit could not scan ${repo_root}" >&2
  exit "${grep_status}"
fi

argv_status=0
(
  cd "${repo_root}"
  git ls-files -z --cached --others --exclude-standard | \
    xargs -0 rg -U -l --color never -e '"node",[[:space:]]*"zero"' --
) >"${legacy_argv_file}" || argv_status=$?

if [[ "${argv_status}" -gt 1 ]]; then
  echo "okou cutover audit could not scan command-boundary argv" >&2
  exit "${argv_status}"
fi

compatibility_count=0
internal_count=0
historical_count=0
fixture_count=0
unclassified_count=0

while IFS=: read -r file line content; do
  [[ -n "${file}" ]] || continue

  # The Desktop release workflow passes the Zero product identity as a
  # function argument. It is not a CLI entry point and Desktop identity is an
  # explicit non-goal of this cutover.
  if [[ "${file}" == ".github/workflows/release-please.yml" && "${content}" == '            zero \' ]]; then
    continue
  fi

  category=""
  case "${file}" in
    */CHANGELOG.md | .claude/notes/* | \
      turbo/apps/api/src/signals/routes/test-user-config-state.ts)
      category="historical"
      historical_count=$((historical_count + 1))
      ;;
  esac

  if [[ -z "${category}" && "${content}" == *"okou-cutover-audit: compatibility-only"* ]]; then
    category="compatibility-only"
    compatibility_count=$((compatibility_count + 1))
  fi

  if [[ -z "${category}" && "${file}" == ".github/scripts/smoke-okou-cli-artifact.sh" && "${content}" == '  zero \' ]]; then
    category="compatibility-only"
    compatibility_count=$((compatibility_count + 1))
  fi

  if [[ -z "${category}" && "${content}" == *"okou-cutover-audit: historical"* ]]; then
    category="historical"
    historical_count=$((historical_count + 1))
  fi

  if [[ -z "${category}" && "${content}" == *"okou-cutover-audit: test-fixture"* ]]; then
    category="test-fixture"
    fixture_count=$((fixture_count + 1))
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

guest_agent_path="crates/guest-agent/src/cli/pi_agent_loop.rs"
if rg -q -F '"zero".to_string()' "${repo_root}/${guest_agent_path}"; then
  echo "unclassified ${guest_agent_path}: guest-agent still invokes zero" >&2
  unclassified_count=$((unclassified_count + 1))
fi
if ! rg -q -F '"okou".to_string()' "${repo_root}/${guest_agent_path}"; then
  echo "unclassified ${guest_agent_path}: canonical okou invocation is missing" >&2
  unclassified_count=$((unclassified_count + 1))
fi

printf 'summary compatibility-only=%s approved-internal-protocol=%s historical=%s test-fixture=%s unclassified=%s\n' \
  "${compatibility_count}" \
  "${internal_count}" \
  "${historical_count}" \
  "${fixture_count}" \
  "${unclassified_count}"

if [[ "${unclassified_count}" -ne 0 ]]; then
  echo "okou cutover audit found unclassified zero command references" >&2
  exit 1
fi
