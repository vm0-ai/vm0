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
    save_runner_group "$output_file"
    op inject --force -i "$tpl_file" -o "$output_file"
    restore_runner_group "$output_file"
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
    save_runner_group "${tpl_file%.tpl}"
    process_tpl_manually "$tpl_file"
    restore_runner_group "${tpl_file%.tpl}"
  done < <(find "$PROJECT_ROOT" -name ".env.local.tpl" -type f)

  echo ""
  echo "✓ All environment variables synced successfully"
}

# --- Computed variables ---
# RUNNER_DEFAULT_GROUP is derived from user input rather than stored in 1Password.
# It must survive template overwrites (both op inject and manual flow).
_SAVED_RUNNER_GROUP=""
WEB_ENV_LOCAL="$PROJECT_ROOT/turbo/apps/web/.env.local"

# Save RUNNER_DEFAULT_GROUP from an env file before it gets overwritten.
save_runner_group() {
  local env_file="$1"
  _SAVED_RUNNER_GROUP=""
  [[ -f "$env_file" ]] || return 0
  _SAVED_RUNNER_GROUP=$(grep "^RUNNER_DEFAULT_GROUP=" "$env_file" 2>/dev/null | head -1 | cut -d= -f2-) || true
}

# Restore saved RUNNER_DEFAULT_GROUP back into the env file.
restore_runner_group() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  [[ -z "$_SAVED_RUNNER_GROUP" ]] && return 0
  if ! grep -q "^RUNNER_DEFAULT_GROUP=" "$env_file" 2>/dev/null; then
    echo "" >> "$env_file"
    echo "# Self-hosted Runner" >> "$env_file"
    echo "RUNNER_DEFAULT_GROUP=${_SAVED_RUNNER_GROUP}" >> "$env_file"
  fi
}

configure_runner_group() {
  [[ -f "$WEB_ENV_LOCAL" ]] || return 0

  local existing
  existing=$(grep "^RUNNER_DEFAULT_GROUP=" "$WEB_ENV_LOCAL" 2>/dev/null | head -1 | cut -d= -f2-) || true

  if [[ -n "$existing" ]]; then
    echo "  ✓ RUNNER_DEFAULT_GROUP=$existing (already set)"
    return 0
  fi

  echo ""
  echo "Enter your name for the runner group (e.g. alice)."
  echo "This sets RUNNER_DEFAULT_GROUP=vm0/local-<name> to route sandbox runs to your runner."

  while true; do
    printf "  Your name: "
    read -r dev_name </dev/tty

    if [[ -z "$dev_name" ]]; then
      echo "  ✗ Name is required"
      continue
    fi

    # Validate: only lowercase letters, digits, and hyphens, must start/end with alphanumeric
    if [[ ! "$dev_name" =~ ^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$ ]]; then
      echo "  ✗ Only lowercase letters, digits, and hyphens allowed, must start/end with alphanumeric"
      continue
    fi

    break
  done

  echo "" >> "$WEB_ENV_LOCAL"
  echo "# Self-hosted Runner" >> "$WEB_ENV_LOCAL"
  echo "RUNNER_DEFAULT_GROUP=vm0/local-${dev_name}" >> "$WEB_ENV_LOCAL"
  echo "  ✓ RUNNER_DEFAULT_GROUP=vm0/local-${dev_name}"
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
