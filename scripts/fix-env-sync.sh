#!/usr/bin/env bash
set -euo pipefail

# Auto-fix 1Password env issues detected by check-env-sync.sh
#
# DEV fixes:
#   1. [Case]   Rename non-UPPERCASE fields → UPPERCASE
#               (1Password rename + .env.local.tpl sed replace)
#   2. [Orphan] Delete 1Password fields not in .env.local.tpl AND not in GitHub
#   3. [Type]   Fix field type to match GitHub (secret→password, variable→text)
#
# PROD fixes:
#   4. [Case]   Rename non-UPPERCASE fields → UPPERCASE
#   5. [Vars]   Auto-sync missing GitHub variables → 1Password text fields
#   6. [Secrets] Prompt user to add missing GitHub secrets → 1Password password fields
#   7. [Type]   Fix field type to match GitHub
#
# Usage: ./scripts/fix-env-sync.sh

# 1Password vault/item mapping (same as sync-oauth.sh)
DEV_VAULT="Development"
DEV_ITEM="vm0-env-local"
PROD_VAULT="Production"
PROD_ITEM="vm0-env-production"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m'

TMPDIR_WORK="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_WORK"' EXIT

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo -e "${RED}Error: $1 is not installed.${NC}"
    exit 1
  fi
}

# Portable sed in-place (works on both macOS/BSD and Linux/GNU)
sed_i() {
  sed -i.bak "$@" && rm -f "${@: -1}.bak"
}

# Safe edit: handles "Password item requires ps value" error
op_safe_edit() {
  local vault="$1" item="$2"
  shift 2
  local err
  if err=$(op item edit "$item" --vault "$vault" "$@" 2>&1 >/dev/null); then
    return 0
  fi
  if [[ "$err" == *"Password item requires ps value"* ]]; then
    op item edit "$item" --vault "$vault" "password[password]=placeholder" "$@" >/dev/null
  else
    echo "$err" >&2
    return 1
  fi
}

# --- Entry point ---

require_tool op
require_tool gh
require_tool jq

echo "Signing in to 1Password..."
eval "$(op signin)"

prefix="${TMPDIR_WORK}/dev"
op_prefix="op://${DEV_VAULT}/${DEV_ITEM}/"

# --- Gather data ---

echo "Scanning .env.local.tpl files..."
> "${prefix}.tpl_fields"
while IFS= read -r -d '' f; do
  grep -o "${op_prefix}[^ \"']*" "$f" 2>/dev/null \
    | sed "s|${op_prefix}||" \
    >> "${prefix}.tpl_fields" || true
done < <(find . -name '.env.local.tpl' -print0)
sort -u "${prefix}.tpl_fields" -o "${prefix}.tpl_fields"
awk '{ print toupper($0) }' "${prefix}.tpl_fields" | sort -u > "${prefix}.tpl_fields_uc"

echo "Fetching 1Password fields..."
op item get "$DEV_ITEM" --vault "$DEV_VAULT" --format json \
  | jq -r '
      .fields[]
      | select(.id != "username" and .id != "password" and .id != "notesPlain")
      | select(.label != null and .label != "")
      | "\(.label)\t\(.label | ascii_upcase)\t\(.type)"
    ' \
  | sort -t$'\t' -k1,1 -u > "${prefix}.raw"

awk -F'\t' '$3 == "CONCEALED" { print $2 }' "${prefix}.raw" | sort -u > "${prefix}.passwords_uc"
awk -F'\t' '$3 != "CONCEALED" { print $2 }' "${prefix}.raw"  | sort -u > "${prefix}.texts_uc"
cat "${prefix}.passwords_uc" "${prefix}.texts_uc" | sort -u > "${prefix}.op_all_uc"

echo "Fetching GitHub repo-level secrets & variables..."
gh secret list --json name -q '.[].name' 2>/dev/null | sort -u > "${prefix}.gh_secrets"
gh variable list --json name -q '.[].name' 2>/dev/null | sort -u > "${prefix}.gh_vars"
cat "${prefix}.gh_secrets" "${prefix}.gh_vars" | sort -u > "${prefix}.gh_all"

# --- Detect orphans (needed to filter other fixes) ---

orphan_set="${prefix}.orphan_set"
> "$orphan_set"

in_op_not_tpl="$(comm -13 "${prefix}.tpl_fields_uc" "${prefix}.op_all_uc")"
if [[ -n "$in_op_not_tpl" ]]; then
  comm -23 <(echo "$in_op_not_tpl" | sort) "${prefix}.gh_all" > "$orphan_set"
fi

is_orphan() { grep -qx "$1" "$orphan_set" 2>/dev/null; }

# --- Detect case fixes (excluding orphans, with correct type from GitHub) ---

case_fixed_set="${prefix}.case_fixed_set"
> "$case_fixed_set"
> "${prefix}.case_fixes"

while IFS=$'\t' read -r original upper type; do
  [[ -z "$original" || "$original" == "$upper" ]] && continue
  is_orphan "$upper" && continue

  op_type="password"
  [[ "$type" != "CONCEALED" ]] && op_type="text"

  # Use GitHub as authority for the correct type
  correct_type="$op_type"
  if [[ "$op_type" == "password" ]] && grep -qx "$upper" "${prefix}.gh_vars" 2>/dev/null; then
    correct_type="text"
  elif [[ "$op_type" == "text" ]] && grep -qx "$upper" "${prefix}.gh_secrets" 2>/dev/null; then
    correct_type="password"
  fi

  printf '%s\t%s\t%s\t%s\n' "$original" "$upper" "$op_type" "$correct_type" >> "${prefix}.case_fixes"
  echo "$upper" >> "$case_fixed_set"
done < "${prefix}.raw"

is_case_fixed() { grep -qx "$1" "$case_fixed_set" 2>/dev/null; }

# --- Detect type-only fixes (excluding orphans and case-fixed fields) ---

> "${prefix}.type_fixes"

while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  is_orphan "$name" && continue
  is_case_fixed "$name" && continue
  if grep -qx "$name" "${prefix}.gh_vars" 2>/dev/null; then
    # Find original-case name
    orig="$(awk -F'\t' -v uc="$name" '$2 == uc { print $1; exit }' "${prefix}.raw")"
    printf '%s\t%s\t%s\t%s\n' "$orig" "$name" "password" "text" >> "${prefix}.type_fixes"
  fi
done < "${prefix}.passwords_uc"

while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  is_orphan "$name" && continue
  is_case_fixed "$name" && continue
  if grep -qx "$name" "${prefix}.gh_secrets" 2>/dev/null; then
    orig="$(awk -F'\t' -v uc="$name" '$2 == uc { print $1; exit }' "${prefix}.raw")"
    printf '%s\t%s\t%s\t%s\n' "$orig" "$name" "text" "password" >> "${prefix}.type_fixes"
  fi
done < "${prefix}.texts_uc"

# --- Count ---

n_case="$(wc -l < "${prefix}.case_fixes" | tr -d ' ')"
n_orphan="$(wc -l < "$orphan_set" | tr -d ' ')"
n_type="$(wc -l < "${prefix}.type_fixes" | tr -d ' ')"
total=$(( n_case + n_orphan + n_type ))

if [[ "$total" -eq 0 ]]; then
  echo -e "\n${GREEN}${BOLD}DEV: No fixes needed.${NC}"
fi

if [[ "$total" -gt 0 ]]; then
  # --- DEV Preview ---

  echo ""
  echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}${CYAN}  Planned DEV fixes for ${DEV_VAULT} / ${DEV_ITEM}${NC}"
  echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════════${NC}"

  if [[ "$n_case" -gt 0 ]]; then
    echo ""
    echo -e "${BOLD}  [Case] Rename to UPPERCASE (1Password + .env.local.tpl):${NC}"
    while IFS=$'\t' read -r old new old_type new_type; do
      label="${old}  →  ${new}"
      if [[ "$old_type" != "$new_type" ]]; then
        label="${label}  (also fix type: ${old_type} → ${new_type})"
      fi
      echo -e "    ${MAGENTA}~ ${label}${NC}"
    done < "${prefix}.case_fixes"
  fi

  if [[ "$n_orphan" -gt 0 ]]; then
    echo ""
    echo -e "${BOLD}  [Orphan] Delete from 1Password:${NC}"
    while IFS= read -r name; do
      echo -e "    ${YELLOW}- ${name}${NC}"
    done < "$orphan_set"
  fi

  if [[ "$n_type" -gt 0 ]]; then
    echo ""
    echo -e "${BOLD}  [Type] Change field type in 1Password:${NC}"
    while IFS=$'\t' read -r orig upper old_type new_type; do
      echo -e "    ${RED}~ ${orig}: ${old_type} → ${new_type}${NC}"
    done < "${prefix}.type_fixes"
  fi

  echo ""
  echo -e "${BOLD}Total: ${total} DEV fixes${NC}"
  echo ""
  read -rp "Proceed with DEV fixes? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy] ]]; then
    echo "DEV fixes skipped."
  else
    # --- DEV Apply ---

    echo ""
    echo -e "${BOLD}Applying DEV fixes...${NC}"

    # 1. Case fixes: read value → delete old → create UPPERCASE → verify → update tpl
    #    NOTE: must delete BEFORE create, because op item edit matches field labels
    #    case-insensitively — creating UPPER while lower exists just updates the
    #    existing field in-place (label stays lowercase).
    while IFS=$'\t' read -r old_name new_name _old_type new_type; do
      echo -n "  Renaming ${old_name} → ${new_name} (${new_type})..."

      val="$(op read "op://${DEV_VAULT}/${DEV_ITEM}/${old_name}")"
      op_safe_edit "$DEV_VAULT" "$DEV_ITEM" "${old_name}[delete]"
      op_safe_edit "$DEV_VAULT" "$DEV_ITEM" "${new_name}[${new_type}]=${val}"

      if ! op read "op://${DEV_VAULT}/${DEV_ITEM}/${new_name}" >/dev/null 2>&1; then
        echo -e " ${RED}FAILED${NC}"
        echo -e "    ${RED}${new_name} was not created. Restoring ${old_name}...${NC}"
        op_safe_edit "$DEV_VAULT" "$DEV_ITEM" "${old_name}[${new_type}]=${val}"
        exit 1
      fi

      while IFS= read -r -d '' f; do
        sed_i "s|${op_prefix}${old_name}|${op_prefix}${new_name}|g" "$f"
      done < <(find . -name '.env.local.tpl' -print0)

      echo -e " ${GREEN}done${NC}"
    done < "${prefix}.case_fixes"

    # 2. Orphan deletes
    while IFS= read -r name; do
      orig="$(awk -F'\t' -v uc="$name" '$2 == uc { print $1; exit }' "${prefix}.raw")"
      [[ -z "$orig" ]] && orig="$name"
      echo -n "  Deleting ${orig}..."
      op_safe_edit "$DEV_VAULT" "$DEV_ITEM" "${orig}[delete]"
      echo -e " ${GREEN}done${NC}"
    done < "$orphan_set"

    # 3. Type fixes: read value → delete → create with correct type → verify
    while IFS=$'\t' read -r orig upper _old_type new_type; do
      echo -n "  Fixing type ${orig} → ${new_type}..."

      val="$(op read "op://${DEV_VAULT}/${DEV_ITEM}/${orig}")"
      op_safe_edit "$DEV_VAULT" "$DEV_ITEM" "${orig}[delete]"
      op_safe_edit "$DEV_VAULT" "$DEV_ITEM" "${upper}[${new_type}]=${val}"

      if ! op read "op://${DEV_VAULT}/${DEV_ITEM}/${upper}" >/dev/null 2>&1; then
        echo -e " ${RED}FAILED${NC}"
        echo -e "    ${RED}${upper} was not created. Restoring ${orig}...${NC}"
        op_safe_edit "$DEV_VAULT" "$DEV_ITEM" "${orig}[${_old_type}]=${val}"
        exit 1
      fi

      echo -e " ${GREEN}done${NC}"
    done < "${prefix}.type_fixes"

    echo ""
    echo -e "${GREEN}${BOLD}DEV: All ${total} fixes applied.${NC}"
  fi
fi

echo ""
if [[ "$total" -gt 0 ]]; then
  echo -e "${GREEN}${BOLD}DEV: All ${total} fixes applied.${NC}"
else
  echo -e "${GREEN}${BOLD}DEV: No fixes needed.${NC}"
fi

# =====================================================================
#  PROD: report-only — no automatic writes to production 1Password
# =====================================================================

echo ""
echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${CYAN}  PRODUCTION — ${PROD_VAULT} / ${PROD_ITEM}${NC}"
echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════════${NC}"
echo ""

prod="${TMPDIR_WORK}/prod"

echo "Fetching 1Password fields..."
op item get "$PROD_ITEM" --vault "$PROD_VAULT" --format json \
  | jq -r '
      .fields[]
      | select(.id != "username" and .id != "password" and .id != "notesPlain")
      | select(.label != null and .label != "")
      | "\(.label)\t\(.label | ascii_upcase)\t\(.type)"
    ' \
  | sort -t$'\t' -k1,1 -u > "${prod}.raw"

awk -F'\t' '$3 == "CONCEALED" { print $2 }' "${prod}.raw" | sort -u > "${prod}.passwords_uc"
awk -F'\t' '$3 != "CONCEALED" { print $2 }' "${prod}.raw"  | sort -u > "${prod}.texts_uc"

echo "Fetching GitHub production secrets & variables..."
gh secret list -e production --json name -q '.[].name' 2>/dev/null | sort -u > "${prod}.gh_secrets"
gh variable list -e production --json name -q '.[].name' 2>/dev/null | sort -u > "${prod}.gh_vars"

prod_issues=false

# Case
echo ""
echo -e "${BOLD}  [Case] 1Password field names must be UPPERCASE${NC}"
case_issues=()
while IFS=$'\t' read -r original upper _type; do
  [[ -z "$original" || "$original" == "$upper" ]] && continue
  case_issues+=("${original}  →  ${upper}")
done < "${prod}.raw"

if [[ ${#case_issues[@]} -eq 0 ]]; then
  echo -e "  ${GREEN}✓ All field names are UPPERCASE${NC}"
else
  prod_issues=true
  for issue in "${case_issues[@]}"; do
    echo -e "    ${MAGENTA}~ ${issue}${NC}"
  done
  echo ""
  echo -e "  ${MAGENTA}Fix in 1Password UI: rename these fields to UPPERCASE${NC}"
fi

# Missing variables
echo ""
echo -e "${BOLD}  [Variables] GitHub → 1Password${NC}"
missing_vars="$(comm -23 "${prod}.gh_vars" "${prod}.texts_uc")"
# Exclude vars that exist as password fields (type mismatch)
if [[ -n "$missing_vars" ]]; then
  filtered=""
  while IFS= read -r name; do
    if ! grep -qx "$name" "${prod}.passwords_uc" 2>/dev/null; then
      filtered="${filtered}${name}\n"
    fi
  done <<< "$missing_vars"
  missing_vars="$(echo -e "$filtered" | sed '/^$/d')"
fi

if [[ -z "$missing_vars" ]]; then
  echo -e "  ${GREEN}✓ All GitHub variables exist in 1Password${NC}"
else
  prod_issues=true
  echo -e "  ${YELLOW}Missing from 1Password (add as text fields):${NC}"
  while IFS= read -r name; do
    val="$(gh variable get "$name" -e production 2>/dev/null)" || val="(could not read)"
    echo -e "    ${YELLOW}+ ${name}${NC} = ${val}"
  done <<< "$missing_vars"
fi

# Missing secrets
echo ""
echo -e "${BOLD}  [Secrets] GitHub → 1Password${NC}"
missing_secrets="$(comm -23 "${prod}.gh_secrets" "${prod}.passwords_uc")"
if [[ -n "$missing_secrets" ]]; then
  filtered=""
  while IFS= read -r name; do
    if ! grep -qx "$name" "${prod}.texts_uc" 2>/dev/null; then
      filtered="${filtered}${name}\n"
    fi
  done <<< "$missing_secrets"
  missing_secrets="$(echo -e "$filtered" | sed '/^$/d')"
fi

if [[ -z "$missing_secrets" ]]; then
  echo -e "  ${GREEN}✓ All GitHub secrets exist in 1Password${NC}"
else
  prod_issues=true
  echo -e "  ${RED}Missing from 1Password (add as password fields manually):${NC}"
  while IFS= read -r name; do
    echo -e "    ${RED}+ ${name}${NC}"
  done <<< "$missing_secrets"
fi

# Type mismatches
echo ""
echo -e "${BOLD}  [Type] password↔secret / text↔variable${NC}"
type_issues=()
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  if grep -qx "$name" "${prod}.gh_vars" 2>/dev/null; then
    type_issues+=("${name}: 1Password=password but GitHub=variable (should be text)")
  fi
done < "${prod}.passwords_uc"
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  if grep -qx "$name" "${prod}.gh_secrets" 2>/dev/null; then
    type_issues+=("${name}: 1Password=text but GitHub=secret (should be password)")
  fi
done < "${prod}.texts_uc"

if [[ ${#type_issues[@]} -eq 0 ]]; then
  echo -e "  ${GREEN}✓ No type mismatches${NC}"
else
  prod_issues=true
  for issue in "${type_issues[@]}"; do
    echo -e "  ${RED}⚠ ${issue}${NC}"
  done
fi

# Summary
echo ""
if [[ "$prod_issues" == false ]]; then
  echo -e "${GREEN}${BOLD}PROD: All good.${NC}"
else
  echo -e "${YELLOW}${BOLD}PROD: Issues found above — please fix manually in 1Password UI.${NC}"
fi

echo ""
echo "Next steps:"
echo "  1. Verify:  ./scripts/check-env-sync.sh"
echo "  2. Commit .env.local.tpl changes if any were modified"
