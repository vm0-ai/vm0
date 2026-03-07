#!/usr/bin/env bash
set -euo pipefail

# Migrate 1Password env secrets from monolithic items to per-app items.
#
# Source:
#   Development/vm0-env-local       → per-app items in Development vault
#   Production/vm0-env-production   → per-app items in Production vault
#
# All secret values flow through memory only — never written to disk.
#
# Usage:
#   ./scripts/migrate-1password.sh              # migrate both vaults
#   ./scripts/migrate-1password.sh --dry-run    # preview without making changes
#   ./scripts/migrate-1password.sh --update-tpl # also rewrite .env.local.tpl paths

DEV_VAULT="Development"
DEV_SRC="vm0-env-local"
PROD_VAULT="Production"
PROD_SRC="vm0-env-production"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN=false
UPDATE_TPL=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=true ;;
    --update-tpl) UPDATE_TPL=true ;;
  esac
done

# ---------------------------------------------------------------------------
# Field → target item mapping
# Format: FIELD_LABEL  item-name
# ---------------------------------------------------------------------------
FIELD_MAP=$(cat <<'EOF'
SECRETS_ENCRYPTION_KEY vm0
PLATFORM_URL vm0
VM0_DEFAULT_AGENT vm0
CLERK_SECRET_KEY clerk
CLERK_PUBLISHABLE_KEY clerk
E2B_API_KEY e2b
R2_ACCOUNT_ID cloudflare
R2_ACCESS_KEY_ID cloudflare
R2_SECRET_ACCESS_KEY cloudflare
R2_USER_STORAGES_BUCKET_NAME cloudflare
AXIOM_TOKEN_SESSIONS axiom
AXIOM_TOKEN_TELEMETRY axiom
SLACK_CLIENT_ID slack
SLACK_CLIENT_SECRET slack
SLACK_SIGNING_SECRET slack
OPENROUTER_API_KEY openrouter
NGROK_API_KEY ngrok
GH_OAUTH_CLIENT_ID github
GH_OAUTH_CLIENT_SECRET github
GITHUB_APP_CLIENT_ID github
GITHUB_APP_CLIENT_SECRET github
GITHUB_APP_ID github
GITHUB_APP_SLUG github
GITHUB_APP_PRIVATE_KEY github
GITHUB_APP_WEBHOOK_SECRET github
AIRTABLE_OAUTH_CLIENT_ID airtable
AIRTABLE_OAUTH_CLIENT_SECRET airtable
NOTION_OAUTH_CLIENT_ID notion
NOTION_OAUTH_CLIENT_SECRET notion
GOOGLE_OAUTH_CLIENT_ID google
GOOGLE_OAUTH_CLIENT_SECRET google
HUBSPOT_OAUTH_CLIENT_ID hubspot
HUBSPOT_OAUTH_CLIENT_SECRET hubspot
DEEL_OAUTH_CLIENT_ID deel
DEEL_OAUTH_CLIENT_SECRET deel
DOCUSIGN_OAUTH_CLIENT_ID docusign
DOCUSIGN_OAUTH_CLIENT_SECRET docusign
DROPBOX_OAUTH_CLIENT_ID dropbox
DROPBOX_OAUTH_CLIENT_SECRET dropbox
LINEAR_OAUTH_CLIENT_ID linear
LINEAR_OAUTH_CLIENT_SECRET linear
FIGMA_OAUTH_CLIENT_ID figma
FIGMA_OAUTH_CLIENT_SECRET figma
MERCURY_OAUTH_CLIENT_ID mercury
MERCURY_OAUTH_CLIENT_SECRET mercury
NEON_OAUTH_CLIENT_ID neon
NEON_OAUTH_CLIENT_SECRET neon
STRAVA_OAUTH_CLIENT_ID strava
STRAVA_OAUTH_CLIENT_SECRET strava
GARMIN_CONNECT_OAUTH_CLIENT_ID garmin-connect
GARMIN_CONNECT_OAUTH_CLIENT_SECRET garmin-connect
REDDIT_OAUTH_CLIENT_ID reddit
REDDIT_OAUTH_CLIENT_SECRET reddit
X_OAUTH_CLIENT_ID x
X_OAUTH_CLIENT_SECRET x
VERCEL_OAUTH_CLIENT_ID vercel
VERCEL_OAUTH_CLIENT_SECRET vercel
VERCEL_INTEGRATION_SLUG vercel
SENTRY_OAUTH_CLIENT_ID sentry
SENTRY_OAUTH_CLIENT_SECRET sentry
INTERVALS_ICU_OAUTH_CLIENT_ID intervals-icu
INTERVALS_ICU_OAUTH_CLIENT_SECRET intervals-icu
XERO_OAUTH_CLIENT_ID xero
XERO_OAUTH_CLIENT_SECRET xero
TODOIST_OAUTH_CLIENT_ID todoist
TODOIST_OAUTH_CLIENT_SECRET todoist
MONDAY_OAUTH_CLIENT_ID monday
MONDAY_OAUTH_CLIENT_SECRET monday
MONDAY_OAUTH_APP_ID monday
WIX_OAUTH_CLIENT_ID wix
WIX_OAUTH_CLIENT_SECRET wix
CANVA_OAUTH_CLIENT_ID canva
CANVA_OAUTH_CLIENT_SECRET canva
SUPABASE_OAUTH_CLIENT_ID supabase
SUPABASE_OAUTH_CLIENT_SECRET supabase
EOF
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: $1 is not installed."
    exit 1
  fi
}

# Unique sorted list of target item names from FIELD_MAP
unique_items() {
  awk 'NF==2 {print $2}' <<< "$FIELD_MAP" | sort -u
}

# ---------------------------------------------------------------------------
# Migrate one vault
# ---------------------------------------------------------------------------
migrate_vault() {
  local vault="$1" src="$2"

  echo ""
  echo "=== $vault (source: $src) ==="

  echo "  Reading source item..."
  local src_json
  src_json=$(op item get "$src" --vault "$vault" --format json)

  while IFS= read -r item; do
    [[ -z "$item" ]] && continue
    echo ""
    echo "  → $item"

    # Build field args: collect all fields belonging to this item
    local -a args=()
    local skipped=0
    while IFS=' ' read -r field target; do
      [[ -z "$field" || "$target" != "$item" ]] && continue

      local value op_type src_type
      value=$(jq -r --arg f "$field" \
        '[.fields[] | select(.label == $f and (.value // "" | ltrimstr(" ")) != "" and .value != "REPLACE_ME")] | first | .value // empty' <<< "$src_json")
      src_type=$(jq -r --arg f "$field" \
        '[.fields[] | select(.label == $f and (.value // "" | ltrimstr(" ")) != "" and .value != "REPLACE_ME")] | first | .type // "STRING"' <<< "$src_json")

      if [[ -z "$value" ]]; then
        echo "    skip: $field (not found or empty in source)"
        (( skipped++ )) || true
        continue
      fi

      [[ "$src_type" == "CONCEALED" ]] && op_type="concealed" || op_type="text"
      args+=("${field}[${op_type}]=${value}")
    done <<< "$FIELD_MAP"

    if [[ ${#args[@]} -eq 0 ]]; then
      echo "    (no fields with values — skipping item)"
      continue
    fi

    # Log field names (never values)
    for arg in "${args[@]}"; do
      local label="${arg%%\[*}"
      local typ="${arg#*\[}"; typ="${typ%%\]*}"
      echo "    + $label [$typ]"
    done
    [[ $skipped -gt 0 ]] && echo "    ($skipped empty/missing fields skipped)"

    if [[ "$DRY_RUN" == "true" ]]; then
      echo "    [dry-run] skipping write"
      continue
    fi

    if op item get "$item" --vault "$vault" </dev/null &>/dev/null; then
      op item edit "$item" --vault "$vault" "${args[@]}" </dev/null >/dev/null
      echo "    Updated (${#args[@]} fields)"
    else
      op item create --category "Secure Note" --title "$item" \
        --vault "$vault" "${args[@]}" </dev/null >/dev/null
      echo "    Created (${#args[@]} fields)"
    fi

  done < <(unique_items)
}

# ---------------------------------------------------------------------------
# Update .env.local.tpl files
# ---------------------------------------------------------------------------
update_tpls() {
  echo ""
  echo "=== Updating .env.local.tpl files ==="

  local -a tpl_files
  mapfile -t tpl_files < <(find "$PROJECT_ROOT" -name "*.env.local.tpl" -type f)

  while IFS=' ' read -r field item; do
    [[ -z "$field" ]] && continue
    local old_ref="op://Development/${DEV_SRC}/${field}"
    local new_ref="op://Development/${item}/${field}"
    for tpl in "${tpl_files[@]}"; do
      if grep -qF "$old_ref" "$tpl"; then
        if [[ "$DRY_RUN" == "true" ]]; then
          echo "  [dry-run] $tpl: $old_ref → $new_ref"
        else
          sed -i "s|${old_ref}|${new_ref}|g" "$tpl"
          echo "  $tpl: $field → $item"
        fi
      fi
    done
  done <<< "$FIELD_MAP"

  echo ""
  echo "  Done. Verify with: git diff '*.tpl'"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
require_tool op
require_tool jq

[[ "$DRY_RUN" == "true" ]] && echo "*** DRY RUN — no changes will be made ***"

echo "Signing in to 1Password..."
eval "$(op signin)"

migrate_vault "$DEV_VAULT" "$DEV_SRC"
migrate_vault "$PROD_VAULT" "$PROD_SRC"

if [[ "$UPDATE_TPL" == "true" ]]; then
  update_tpls
fi

echo ""
echo "=== Done ==="
if [[ "$UPDATE_TPL" == "false" ]]; then
  echo "TPL files not updated. Re-run with --update-tpl when ready."
fi
