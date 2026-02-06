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

  find "$PROJECT_ROOT" -name ".env.local.tpl" -type f | while IFS= read -r tpl_file; do
    output_file="${tpl_file%.tpl}"
    echo ""
    echo "Syncing: $tpl_file"
    echo "Output:  $output_file"
    op inject --force -i "$tpl_file" -o "$output_file"
    echo "✓ Synced successfully"
  done

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

  find "$PROJECT_ROOT" -name ".env.local.tpl" -type f | while IFS= read -r tpl_file; do
    process_tpl_manually "$tpl_file"
  done

  echo ""
  echo "✓ All environment variables synced successfully"
}

# --- Main ---
echo "Are you a vm0 team member with 1Password access? (y/n)"
read -r use_1password

if [[ "$use_1password" =~ ^[Yy] ]]; then
  sync_with_1password
else
  sync_with_manual_input
fi
