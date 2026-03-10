#!/usr/bin/env bash
set -e

# Sync all environment variables from .env.local.tpl files
# Supports two data providers:
#   - 1Password CLI (for vm0 team members)
#   - Interactive manual input (for community contributors)
#
# Usage: ./scripts/sync-env.sh

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- 1Password provider (existing flow) ---
sync_with_1password() {
  if ! command -v op >/dev/null 2>&1; then
    echo "Error: 1Password CLI (op) is not installed"
    echo "Install it from: https://developer.1password.com/docs/cli/get-started/"
    exit 1
  fi

  echo "Signing in to 1Password..."
  eval "$(op signin)"

  echo "Syncing all environment templates..."

  while IFS= read -r tpl_file; do
    output_file="${tpl_file%.tpl}"
    echo ""
    echo "Syncing: $tpl_file"
    echo "Output:  $output_file"
    op inject --force -i "$tpl_file" -o "$output_file"
    echo "✓ Synced successfully"
  done < <(find "$PROJECT_ROOT" -name ".env.local.tpl" -type f)

  echo ""
  echo "✓ All environment variables synced successfully"
}

# --- Manual input provider (community flow) ---
process_tpl_manually() {
  local tpl_file="$1"
  local output_file="${tpl_file%.tpl}"

  echo ""
  echo "Processing: $tpl_file"
  echo "Output:     $output_file"

  # Load existing .env.local values if the file exists
  declare -A existing_values
  if [[ -f "$output_file" ]]; then
    while IFS= read -r line; do
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ -z "$line" ]] && continue
      if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*) ]]; then
        existing_values["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
      fi
    done < "$output_file"
  fi

  # Parse .tpl and build output
  local output=""
  local accumulated_comments=""

  while IFS= read -r line; do
    # Empty line: write it and reset comments
    if [[ -z "$line" ]]; then
      output+=$'\n'
      accumulated_comments=""
      continue
    fi

    # Comment line: accumulate for context
    if [[ "$line" =~ ^[[:space:]]*# ]]; then
      accumulated_comments+="$line"$'\n'
      output+="$line"$'\n'
      continue
    fi

    # Variable line: KEY=VALUE
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*) ]]; then
      local key="${BASH_REMATCH[1]}"
      local value="${BASH_REMATCH[2]}"

      if [[ "$value" == op://* ]]; then
        # This is a secret — needs human input
        if [[ -n "${existing_values[$key]+x}" && -n "${existing_values[$key]}" ]]; then
          echo "  ✓ $key (already set)"
          output+="$key=${existing_values[$key]}"$'\n'
        else
          # Show accumulated comments as context
          if [[ -n "$accumulated_comments" ]]; then
            echo ""
            printf '%s' "$accumulated_comments" | sed 's/^/  /'
          fi

          # Special case: SECRETS_ENCRYPTION_KEY can be auto-generated
          if [[ "$key" == "SECRETS_ENCRYPTION_KEY" ]]; then
            local generated
            generated=$(openssl rand -hex 32)
            echo "  $key (press Enter to auto-generate):"
            read -r user_value </dev/tty
            if [[ -z "$user_value" ]]; then
              user_value="$generated"
              echo "  ✓ $key (auto-generated)"
            fi
          else
            echo "  $key:"
            read -r user_value </dev/tty
          fi

          output+="$key=$user_value"$'\n'
        fi
      else
        # Static or empty value — copy as-is
        output+="$line"$'\n'
      fi

      accumulated_comments=""
    else
      # Unknown line format — copy as-is
      output+="$line"$'\n'
    fi
  done < "$tpl_file"

  # Write output file
  printf '%s' "$output" > "$output_file"
  echo "✓ Synced successfully"
}

sync_with_manual_input() {
  echo ""
  echo "Interactive mode: you will be prompted to provide values for secret variables."
  echo "Press Enter to skip optional variables or use auto-generated defaults."
  echo ""

  while IFS= read -r tpl_file; do
    process_tpl_manually "$tpl_file"
  done < <(find "$PROJECT_ROOT" -name ".env.local.tpl" -type f)

  echo ""
  echo "✓ All environment variables synced successfully"
}

WEB_ENV_LOCAL="$PROJECT_ROOT/turbo/apps/web/.env.local"

# --- Computed variables ---
# RUNNER_DEFAULT_GROUP is auto-derived from git email + hostname.
configure_runner_group() {
  [[ -f "$WEB_ENV_LOCAL" ]] || return 0

  # Derive from git email + hostname (e.g. alice@vm0.ai on macbook -> alice-macbook)
  local username hostname_short
  username=$(git config user.email 2>/dev/null | sed 's/@.*//' | tr '[:upper:].' '[:lower:]-' | sed 's/-$//' || true)
  hostname_short=$(hostname -s)

  if [[ -z "$username" ]]; then
    echo "  ✗ RUNNER_DEFAULT_GROUP skipped (git user.email not configured)"
    return 0
  fi

  local group_name="vm0/local-${username}-${hostname_short}"

  # Remove old value and its comment header if present, then append fresh
  if grep -q "^RUNNER_DEFAULT_GROUP=" "$WEB_ENV_LOCAL" 2>/dev/null; then
    sed -i '/^# Self-hosted Runner$/d; /^RUNNER_DEFAULT_GROUP=/d' "$WEB_ENV_LOCAL"
  fi

  # Remove trailing blank lines before appending
  while [[ -s "$WEB_ENV_LOCAL" && -z "$(tail -c 1 "$WEB_ENV_LOCAL")" ]] && tail -1 "$WEB_ENV_LOCAL" | grep -q '^$'; do
    sed -i '$ d' "$WEB_ENV_LOCAL"
  done

  echo "" >> "$WEB_ENV_LOCAL"
  echo "# Self-hosted Runner" >> "$WEB_ENV_LOCAL"
  echo "RUNNER_DEFAULT_GROUP=${group_name}" >> "$WEB_ENV_LOCAL"
  echo "  ✓ RUNNER_DEFAULT_GROUP=${group_name}"
}

# --- Main ---
echo "Are you a vm0 team member with 1Password access? (y/n)"
read -r use_1password

if [[ "$use_1password" =~ ^[Yy] ]]; then
  sync_with_1password
else
  sync_with_manual_input
fi

configure_runner_group
