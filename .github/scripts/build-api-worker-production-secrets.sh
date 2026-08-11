#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    fail "Missing required environment variable: ${name}"
  fi
}

for name in \
  API_ENV_FILE \
  CF_ACCESS_AUD \
  CF_ACCESS_TEAM_DOMAIN \
  CF_API_PRODUCTION_CANDIDATE_ORIGIN \
  CF_API_PRODUCTION_R2_SENTINEL_KEY \
  CF_API_PUBLIC_ORIGIN \
  GITHUB_OUTPUT \
  RUNNER_TEMP; do
  require_env "$name"
done

[ -f "$API_ENV_FILE" ] || fail "API_ENV_FILE does not exist: ${API_ENV_FILE}"
grep -Fxq 'ENV=production' "$API_ENV_FILE" ||
  fail "Worker production environment must contain ENV=production"

worker_env_file="${RUNNER_TEMP}/vm0-api-worker-production.env"
worker_secrets_file="${RUNNER_TEMP}/vm0-api-worker-production-secrets.json"
cp "$API_ENV_FILE" "$worker_env_file"
chmod 600 "$worker_env_file"

for name in \
  CF_ACCESS_AUD \
  CF_ACCESS_JWKS \
  CF_ACCESS_TEAM_DOMAIN \
  CF_API_PRODUCTION_CANDIDATE_ORIGIN \
  CF_API_PRODUCTION_R2_SENTINEL_KEY \
  CF_API_PUBLIC_ORIGIN; do
  if grep -q "^${name}=" "$worker_env_file"; then
    fail "${name} is already present in the shared production API environment"
  fi
done

case "$CF_ACCESS_TEAM_DOMAIN" in
  https://*) access_origin=${CF_ACCESS_TEAM_DOMAIN%/} ;;
  *) access_origin="https://${CF_ACCESS_TEAM_DOMAIN%/}" ;;
esac
access_jwks=$(curl \
  --fail \
  --show-error \
  --silent \
  --max-time 30 \
  --retry 3 \
  --retry-delay 2 \
  --retry-all-errors \
  "${access_origin}/cdn-cgi/access/certs" | jq -ce '
    select(
      (.keys | type) == "array" and
      (.keys | length) > 0 and
      all(.keys[];
        .kty == "RSA" and
        .alg == "RS256" and
        .use == "sig" and
        ((.kid | type) == "string") and
        ((.e | type) == "string") and
        ((.n | type) == "string")
      )
    ) | {keys}
  ')

{
  printf 'CF_ACCESS_AUD=%s\n' "$CF_ACCESS_AUD"
  printf 'CF_ACCESS_JWKS=%s\n' "$access_jwks"
  printf 'CF_ACCESS_TEAM_DOMAIN=%s\n' "$CF_ACCESS_TEAM_DOMAIN"
  printf 'CF_API_PRODUCTION_CANDIDATE_ORIGIN=%s\n' "$CF_API_PRODUCTION_CANDIDATE_ORIGIN"
  printf 'CF_API_PRODUCTION_R2_SENTINEL_KEY=%s\n' "$CF_API_PRODUCTION_R2_SENTINEL_KEY"
  printf 'CF_API_PUBLIC_ORIGIN=%s\n' "$CF_API_PUBLIC_ORIGIN"
} >>"$worker_env_file"

node turbo/apps/api/scripts/build-worker-secrets.mjs \
  "$worker_env_file" \
  "$worker_secrets_file"
chmod 600 "$worker_secrets_file"
echo "file=${worker_secrets_file}" >>"$GITHUB_OUTPUT"
echo "Built production Worker secret shards."
