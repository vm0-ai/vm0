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

cat > "${FAKE_BIN}/stripe" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--version" ]]; then
  echo "stripe version fake"
  exit 0
fi

printf '%s\n' "$*" >> "$STRIPE_ARGS_LOG"

if [[ "${1:-}" == "--api-key" ]]; then
  shift 2
fi

case "${1:-} ${2:-}" in
  "webhook_endpoints list")
    cat "$FAKE_STRIPE_LIST_JSON"
    ;;
  "webhook_endpoints delete")
    printf '{"id":"%s","deleted":true}\n' "$3"
    ;;
  "webhook_endpoints create")
    printf '{"id":"we_new","secret":"whsec_new"}\n'
    ;;
  *)
    echo "unexpected stripe call: $*" >&2
    exit 1
    ;;
esac
BASH
chmod +x "${FAKE_BIN}/stripe"

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
  bash "$SCRIPT" upsert >/tmp/stripe-preview-webhook-upsert.out

assert_contains "$ARGS_LOG" "webhook_endpoints delete we_managed_job --confirm"
assert_contains "$ARGS_LOG" "webhook_endpoints delete we_managed_url --confirm"
assert_not_contains "$ARGS_LOG" "webhook_endpoints delete we_unmanaged_job --confirm"
assert_not_contains "$ARGS_LOG" "webhook_endpoints delete we_unmanaged_url --confirm"
assert_contains "$ARGS_LOG" "webhook_endpoints create"
assert_contains "$ARGS_LOG" "--url https://pr-123-api.vm0.test/api/webhooks/stripe"
assert_contains "$ARGS_LOG" "metadata[job_ref]=pr-123"
assert_contains "$ARGS_LOG" "--enabled-events invoice.paid"
assert_contains "$API_ENV_FILE" "STRIPE_WEBHOOK_SECRET=whsec_new"

: > "$ARGS_LOG"
HOME="$HOME_DIR" \
  PATH="${FAKE_BIN}:${PATH}" \
  STRIPE_ARGS_LOG="$ARGS_LOG" \
  FAKE_STRIPE_LIST_JSON="$LIST_JSON" \
  STRIPE_SECRET_KEY="sk_test_fake" \
  JOB_REF="pr-123" \
  bash "$SCRIPT" cleanup >/tmp/stripe-preview-webhook-cleanup.out

assert_contains "$ARGS_LOG" "webhook_endpoints delete we_managed_job --confirm"
assert_not_contains "$ARGS_LOG" "webhook_endpoints delete we_unmanaged_job --confirm"

: > "$ARGS_LOG"
HOME="$HOME_DIR" \
  PATH="${FAKE_BIN}:${PATH}" \
  STRIPE_ARGS_LOG="$ARGS_LOG" \
  FAKE_STRIPE_LIST_JSON="$LIST_JSON" \
  STRIPE_SECRET_KEY="sk_test_fake" \
  JOB_REF="staging" \
  API_ENV_FILE="$API_ENV_FILE" \
  bash "$SCRIPT" upsert >/tmp/stripe-preview-webhook-staging.out

if [[ -s "$ARGS_LOG" ]]; then
  fail "expected non-PR upsert to skip Stripe API calls"
fi

echo "stripe-preview-webhook-test: ok"
