#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${EXPECTED_KEYS:-}" ]]; then
  echo "::error::EXPECTED_KEYS is required"
  exit 1
fi

hash_value() {
  printf '%s' "$1" | sha256sum | cut -d' ' -f1
}

mask_value() {
  if [[ "${GITHUB_ACTIONS:-}" != "true" || -z "$1" ]]; then
    return
  fi
  local value="$1"
  value="${value//'%'/'%25'}"
  value="${value//$'\r'/'%0D'}"
  value="${value//$'\n'/'%0A'}"
  echo "::add-mask::$value"
}

doppler_location() {
  printf '%s/%s' "${DOPPLER_PROJECT:-unknown-project}" "${DOPPLER_CONFIG:-unknown-config}"
}

failures=0
checked=0
warnings=0
compared=0

while IFS= read -r key; do
  [[ -n "$key" ]] || continue
  checked=$((checked + 1))

  repository_kind=
  repository_key=
  case "$key" in
    *_OAUTH_CLIENT_ID)
      repository_kind="GitHub variables"
      repository_key="REPOSITORY_VAR_${key}"
      ;;
    *_OAUTH_CLIENT_SECRET)
      repository_kind="GitHub secrets"
      repository_key="REPOSITORY_SECRET_${key}"
      ;;
    *)
      echo "::error::${key} is not a supported OAuth client config key"
      failures=$((failures + 1))
      continue
      ;;
  esac

  if [[ -z "${!key+x}" ]]; then
    echo "::error::${key} is missing from Doppler ($(doppler_location))"
    failures=$((failures + 1))
    continue
  fi

  doppler_value="${!key}"
  if [[ -z "$doppler_value" ]]; then
    echo "::error::${key} is empty in Doppler ($(doppler_location))"
    failures=$((failures + 1))
    continue
  fi
  mask_value "$doppler_value"

  github_key="$repository_key"
  github_value="${!github_key-}"
  if [[ -z "$github_value" ]]; then
    echo "::warning::${key} is missing from ${repository_kind}; Doppler has a value"
    warnings=$((warnings + 1))
    continue
  fi
  mask_value "$github_value"

  if [[ "$(hash_value "$github_value")" != "$(hash_value "$doppler_value")" ]]; then
    echo "::error::${key} differs between ${repository_kind} and Doppler ($(doppler_location))"
    failures=$((failures + 1))
    continue
  fi

  echo "ok: ${key}"
  compared=$((compared + 1))
done <<< "$EXPECTED_KEYS"

echo "Checked ${checked} $(doppler_location) OAuth client config entries (${compared} compared, ${warnings} warning(s))"

if [[ "$failures" -gt 0 ]]; then
  echo "::error::${failures} OAuth client config comparison(s) failed"
  exit 1
fi
