#!/usr/bin/env bash
set -euo pipefail

# Dump 1Password env items to local files for analysis.
# Secrets never touch disk — all processing is done in memory (pipes).
#
# Outputs:
#   /tmp/op-dump/env-local.json       - Development/vm0-env-local (CONCEALED values stripped)
#   /tmp/op-dump/env-production.json  - Production/vm0-env-production (CONCEALED values stripped)
#   /tmp/op-dump/env-local.env        - KEY=VALUE format (secrets shown as <secret>)
#   /tmp/op-dump/env-production.env   - KEY=VALUE format (secrets shown as <secret>)
#
# Usage: ./scripts/dump-1password-envs.sh

DEV_VAULT="Development"
DEV_ITEM="vm0-env-local"
PROD_VAULT="Production"
PROD_ITEM="vm0-env-production"
OUT_DIR="/tmp/op-dump"

if ! command -v op >/dev/null 2>&1; then
  echo "Error: 1Password CLI (op) is not installed"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is not installed"
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "Signing in to 1Password..."
eval "$(op signin)"

# Strip values from CONCEALED fields before writing to disk
strip_secrets() {
  jq '
    .fields |= map(
      if .type == "CONCEALED" then .value = "<secret>"
      else .
      end
    )
  '
}

# Convert stripped JSON to KEY=VALUE format (CONCEALED already replaced with <secret>)
json_to_env() {
  jq -r '
    .fields[]
    | select(.label != null and .label != "" and .label != "notesPlain" and .label != "password")
    | "\(.label)=\(.value // "")"
  '
}

echo ""
echo "Fetching ${DEV_VAULT}/${DEV_ITEM}..."
op item get "$DEV_ITEM" --vault "$DEV_VAULT" --format json \
  | strip_secrets > "${OUT_DIR}/env-local.json"
echo "  Saved: ${OUT_DIR}/env-local.json"

echo "Fetching ${PROD_VAULT}/${PROD_ITEM}..."
op item get "$PROD_ITEM" --vault "$PROD_VAULT" --format json \
  | strip_secrets > "${OUT_DIR}/env-production.json"
echo "  Saved: ${OUT_DIR}/env-production.json"

echo ""
echo "Converting to .env format..."
json_to_env < "${OUT_DIR}/env-local.json" > "${OUT_DIR}/env-local.env"
echo "  Saved: ${OUT_DIR}/env-local.env"

json_to_env < "${OUT_DIR}/env-production.json" > "${OUT_DIR}/env-production.env"
echo "  Saved: ${OUT_DIR}/env-production.env"

# Print summary
echo ""
echo "=== Summary ==="
echo ""
echo "env-local (${DEV_VAULT}/${DEV_ITEM}):"
echo "  Field count: $(jq '[.fields[] | select(.label != null and .label != "")] | length' "${OUT_DIR}/env-local.json")"
echo "  Keys:"
jq -r '.fields[] | select(.label != null and .label != "") | "    \(.label) [\(.type)]"' "${OUT_DIR}/env-local.json"

echo ""
echo "env-production (${PROD_VAULT}/${PROD_ITEM}):"
echo "  Field count: $(jq '[.fields[] | select(.label != null and .label != "")] | length' "${OUT_DIR}/env-production.json")"
echo "  Keys:"
jq -r '.fields[] | select(.label != null and .label != "") | "    \(.label) [\(.type)]"' "${OUT_DIR}/env-production.json"

echo ""
echo "=== Done ==="
echo "Files saved to ${OUT_DIR}/ (all CONCEALED values replaced with <secret>)"
