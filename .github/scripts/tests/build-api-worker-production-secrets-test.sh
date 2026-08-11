#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
script="${repo_root}/.github/scripts/build-api-worker-production-secrets.sh"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="${tmp_dir}/bin"
mkdir -p "$fake_bin"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cat >"${fake_bin}/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
url=${!#}
[ "$url" = "https://access.example.com/cdn-cgi/access/certs" ] || {
  echo "unexpected curl URL: $url" >&2
  exit 2
}
jq -n '{keys: [{
  kty: "RSA",
  alg: "RS256",
  use: "sig",
  kid: "test-key",
  e: "AQAB",
  n: "test-modulus"
}]}'
SH
chmod +x "${fake_bin}/curl"

run_builder() {
  local input_file=$1
  local output_file=$2
  : >"$output_file"
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    API_ENV_FILE="$input_file" \
    CF_ACCESS_AUD=test-audience \
    CF_ACCESS_TEAM_DOMAIN=access.example.com \
    CF_API_PRODUCTION_CANDIDATE_ORIGIN=https://api-worker-candidate.vm0.ai \
    CF_API_PRODUCTION_R2_SENTINEL_KEY=readiness/sentinel.txt \
    CF_API_PUBLIC_ORIGIN=https://api.vm0.ai \
    GITHUB_OUTPUT="$output_file" \
    RUNNER_TEMP="$tmp_dir" \
    bash "$script"
}

input_file="${tmp_dir}/production.env"
printf 'ENV=production\nDATABASE_URL=postgres://example\n' >"$input_file"
output_file="${tmp_dir}/success.output"
run_builder "$input_file" "$output_file"

secrets_file=$(sed -n 's/^file=//p' "$output_file")
[ -f "$secrets_file" ] || fail "builder did not publish a secrets file"
[ "$(jq -r 'keys | length' "$secrets_file")" -eq 32 ] || fail "builder did not emit all 32 shards"

decoded=$(jq -c '[to_entries[].value | fromjson] | add' "$secrets_file")
jq -e '
  .ENV == "production" and
  .DATABASE_URL == "postgres://example" and
  .CF_ACCESS_AUD == "test-audience" and
  .CF_ACCESS_TEAM_DOMAIN == "access.example.com" and
  .CF_API_PRODUCTION_CANDIDATE_ORIGIN == "https://api-worker-candidate.vm0.ai" and
  .CF_API_PRODUCTION_R2_SENTINEL_KEY == "readiness/sentinel.txt" and
  .CF_API_PUBLIC_ORIGIN == "https://api.vm0.ai" and
  (.CF_ACCESS_JWKS | fromjson | .keys[0].kid) == "test-key"
' <<<"$decoded" >/dev/null || fail "production Worker configuration was not encoded correctly"

conflict_file="${tmp_dir}/conflict.env"
printf 'ENV=production\nCF_ACCESS_AUD=shared-value\n' >"$conflict_file"
if run_builder "$conflict_file" "${tmp_dir}/conflict.output" \
  >"${tmp_dir}/conflict.log" 2>&1; then
  fail "shared environment conflict should fail"
fi
grep -q 'CF_ACCESS_AUD is already present' "${tmp_dir}/conflict.log" ||
  fail "shared environment conflict was not reported"

echo "build-api-worker-production-secrets tests passed"
