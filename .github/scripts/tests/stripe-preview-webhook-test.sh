#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="${REPO_ROOT}/.github/scripts/stripe-preview-webhook.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq -- "$expected" "$file" ||
    fail "expected ${file} to contain: ${expected}"
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$file"; then
    fail "did not expect ${file} to contain: ${unexpected}"
  fi
}

HOME_DIR="${TMPDIR}/home"
FAKE_BIN="${HOME_DIR}/.local/bin"
mkdir -p "$FAKE_BIN"

cat > "${FAKE_BIN}/curl" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

method=""
output_file=""
url=""
data=()
headers=()

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --request)
      method="$2"
      shift 2
      ;;
    --user | --retry | --retry-delay | --retry-max-time | --connect-timeout | --max-time | --write-out)
      shift 2
      ;;
    --header)
      headers+=("$2")
      shift 2
      ;;
    --output)
      output_file="$2"
      shift 2
      ;;
    --data-urlencode)
      data+=("$2")
      shift 2
      ;;
    --silent | --show-error | --retry-all-errors | --get)
      shift
      ;;
    http://* | https://*)
      url="$1"
      shift
      ;;
    *)
      echo "unexpected curl argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$method" || -z "$output_file" || -z "$url" ]]; then
  echo "missing fake curl method, output file, or url" >&2
  exit 1
fi

printf '%s %s\n' "$method" "$url" >> "$STRIPE_ARGS_LOG"
for item in "${data[@]}"; do
  printf 'data %s\n' "$item" >> "$STRIPE_ARGS_LOG"
done
for item in "${headers[@]}"; do
  printf 'header %s\n' "$item" >> "$STRIPE_ARGS_LOG"
done

path="${url#https://api.stripe.com/v1}"
http_status=200
body=""

case "$method $path" in
  "GET /webhook_endpoints")
    body="$(cat "$FAKE_STRIPE_LIST_JSON")"
    ;;
  DELETE\ /webhook_endpoints/*)
    endpoint_id="${path##*/}"
    body="{\"id\":\"${endpoint_id}\",\"deleted\":true}"
    ;;
  "POST /webhook_endpoints")
    http_status="${FAKE_STRIPE_CREATE_STATUS:-200}"
    body="${FAKE_STRIPE_CREATE_JSON:-{\"id\":\"we_new\",\"secret\":\"whsec_new\"}}"
    ;;
  *)
    echo "unexpected fake curl request: $method $path" >&2
    exit 1
    ;;
esac

printf '%s\n' "$body" > "$output_file"
printf '%s' "$http_status"
BASH
chmod +x "${FAKE_BIN}/curl"

LIST_JSON="${TMPDIR}/endpoints.json"
cat > "$LIST_JSON" <<'JSON'
{
  "data": [
    {
      "id": "we_managed_job",
      "url": "https://old.example.test/api/webhooks/stripe",
      "metadata": {
        "managed_by": "github-actions",
        "job_ref": "pr-123"
      }
    },
    {
      "id": "we_managed_url",
      "url": "https://pr-123-api.vm0.test/api/webhooks/stripe",
      "metadata": {
        "managed_by": "github-actions",
        "job_ref": "pr-456"
      }
    },
    {
      "id": "we_unmanaged_job",
      "url": "https://unmanaged.example.test/api/webhooks/stripe",
      "metadata": {
        "job_ref": "pr-123"
      }
    },
    {
      "id": "we_unmanaged_url",
      "url": "https://pr-123-api.vm0.test/api/webhooks/stripe",
      "metadata": {}
    }
  ],
  "has_more": false
}
JSON

ARGS_LOG="${TMPDIR}/stripe-args.log"
API_ENV_FILE="${TMPDIR}/api.env"
printf 'STRIPE_WEBHOOK_SECRET=whsec_old\n' > "$API_ENV_FILE"

HOME="$HOME_DIR" \
  PATH="${FAKE_BIN}:${PATH}" \
  STRIPE_ARGS_LOG="$ARGS_LOG" \
  FAKE_STRIPE_LIST_JSON="$LIST_JSON" \
  STRIPE_SECRET_KEY="sk_test_fake" \
  JOB_REF="pr-123" \
  API_PREVIEW_URL="https://pr-123-api.vm0.test" \
  API_ENV_FILE="$API_ENV_FILE" \
  bash "$SCRIPT" upsert >"${TMPDIR}/stripe-preview-webhook-upsert.out"

assert_contains "$ARGS_LOG" "DELETE https://api.stripe.com/v1/webhook_endpoints/we_managed_job"
assert_contains "$ARGS_LOG" "DELETE https://api.stripe.com/v1/webhook_endpoints/we_managed_url"
assert_not_contains "$ARGS_LOG" "DELETE https://api.stripe.com/v1/webhook_endpoints/we_unmanaged_job"
assert_not_contains "$ARGS_LOG" "DELETE https://api.stripe.com/v1/webhook_endpoints/we_unmanaged_url"
assert_contains "$ARGS_LOG" "POST https://api.stripe.com/v1/webhook_endpoints"
assert_contains "$ARGS_LOG" "header Idempotency-Key: vm0-preview-webhook-pr-123-local-0"
assert_contains "$ARGS_LOG" "data url=https://pr-123-api.vm0.test/api/webhooks/stripe"
assert_contains "$ARGS_LOG" "data metadata[job_ref]=pr-123"
assert_contains "$ARGS_LOG" "data enabled_events[]=invoice.paid"
assert_contains "$API_ENV_FILE" "STRIPE_WEBHOOK_SECRET=whsec_new"

: > "$ARGS_LOG"
HOME="$HOME_DIR" \
  PATH="${FAKE_BIN}:${PATH}" \
  STRIPE_ARGS_LOG="$ARGS_LOG" \
  FAKE_STRIPE_LIST_JSON="$LIST_JSON" \
  STRIPE_SECRET_KEY="sk_test_fake" \
  JOB_REF="pr-123" \
  bash "$SCRIPT" cleanup >"${TMPDIR}/stripe-preview-webhook-cleanup.out"

assert_contains "$ARGS_LOG" "DELETE https://api.stripe.com/v1/webhook_endpoints/we_managed_job"
assert_not_contains "$ARGS_LOG" "DELETE https://api.stripe.com/v1/webhook_endpoints/we_unmanaged_job"

: > "$ARGS_LOG"
HOME="$HOME_DIR" \
  PATH="${FAKE_BIN}:${PATH}" \
  STRIPE_ARGS_LOG="$ARGS_LOG" \
  FAKE_STRIPE_LIST_JSON="$LIST_JSON" \
  STRIPE_SECRET_KEY="sk_test_fake" \
  JOB_REF="staging" \
  API_ENV_FILE="$API_ENV_FILE" \
  bash "$SCRIPT" upsert >"${TMPDIR}/stripe-preview-webhook-staging.out"

if [[ -s "$ARGS_LOG" ]]; then
  fail "expected non-PR upsert to skip Stripe API calls"
fi

: > "$ARGS_LOG"
ERROR_JSON='{"error":{"type":"invalid_request_error","code":"url_invalid","message":"Invalid webhook URL"}}'
set +e
HOME="$HOME_DIR" \
  PATH="${FAKE_BIN}:${PATH}" \
  STRIPE_ARGS_LOG="$ARGS_LOG" \
  FAKE_STRIPE_LIST_JSON="$LIST_JSON" \
  FAKE_STRIPE_CREATE_JSON="$ERROR_JSON" \
  FAKE_STRIPE_CREATE_STATUS=400 \
  STRIPE_SECRET_KEY="sk_test_fake" \
  JOB_REF="pr-123" \
  API_PREVIEW_URL="https://pr-123-api.vm0.test" \
  API_ENV_FILE="$API_ENV_FILE" \
  bash "$SCRIPT" upsert >"${TMPDIR}/stripe-preview-webhook-error.out" 2>"${TMPDIR}/stripe-preview-webhook-error.err"
status=$?
set -e
if [[ "$status" -eq 0 ]]; then
  fail "expected Stripe HTTP error to fail"
fi
assert_contains "${TMPDIR}/stripe-preview-webhook-error.err" "Stripe API POST /webhook_endpoints failed with HTTP 400"
assert_contains "${TMPDIR}/stripe-preview-webhook-error.err" "invalid_request_error: url_invalid: Invalid webhook URL"
assert_not_contains "${TMPDIR}/stripe-preview-webhook-error.out" "::add-mask::"

: > "$ARGS_LOG"
UNEXPECTED_JSON='{"dry_run":{"method":"POST","url":"https://api.stripe.com/v1/webhook_endpoints"}}'
set +e
HOME="$HOME_DIR" \
  PATH="${FAKE_BIN}:${PATH}" \
  STRIPE_ARGS_LOG="$ARGS_LOG" \
  FAKE_STRIPE_LIST_JSON="$LIST_JSON" \
  FAKE_STRIPE_CREATE_JSON="$UNEXPECTED_JSON" \
  STRIPE_SECRET_KEY="sk_test_fake" \
  JOB_REF="pr-123" \
  API_PREVIEW_URL="https://pr-123-api.vm0.test" \
  API_ENV_FILE="$API_ENV_FILE" \
  bash "$SCRIPT" upsert >"${TMPDIR}/stripe-preview-webhook-unexpected.out" 2>"${TMPDIR}/stripe-preview-webhook-unexpected.err"
status=$?
set -e
if [[ "$status" -eq 0 ]]; then
  fail "expected unexpected Stripe response to fail"
fi
assert_contains "${TMPDIR}/stripe-preview-webhook-unexpected.err" "Stripe did not return a webhook endpoint id"
assert_contains "${TMPDIR}/stripe-preview-webhook-unexpected.err" "keys=dry_run"
assert_not_contains "${TMPDIR}/stripe-preview-webhook-unexpected.out" "::add-mask::"

echo "stripe-preview-webhook-test: ok"
