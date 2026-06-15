#!/usr/bin/env bash
# profile-tests.sh — Run test files one-by-one and measure wall + CPU time.
#
# Usage:
#   ./scripts/profile-tests.sh [workspace] [--top N]
#
# workspace: web | cli | platform | core | firewalls-generator | all  (default: all)
# --top N  : show only N slowest files in the final summary (default: 30)
#
# Output:
#   - Live progress line per file: status, wall time, CPU time, file path
#   - Final sorted table by CPU time
#   - Results saved to turbo/test-profile-results.tsv
#
# Example:
#   ./scripts/profile-tests.sh web
#   ./scripts/profile-tests.sh web --top 10

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TURBO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS_FILE="$TURBO_DIR/test-profile-results.tsv"

# ─── Args ────────────────────────────────────────────────────────────────────
WORKSPACE="${1:-all}"
TOP_N=30
for arg in "$@"; do
  if [[ "$arg" == "--top" ]]; then
    NEXT_IS_N=1
  elif [[ "${NEXT_IS_N:-0}" == "1" ]]; then
    TOP_N="$arg"
    NEXT_IS_N=0
  fi
done

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
BLU='\033[0;34m'
DIM='\033[2m'
RST='\033[0m'

# ─── Helpers ─────────────────────────────────────────────────────────────────
get_filter() {
  local file="$1"
  if   [[ "$file" == */apps/web/* ]];               then echo "web"
  elif [[ "$file" == */apps/cli/* ]];               then echo "@vm0/cli"
  elif [[ "$file" == */apps/platform/* ]];          then echo "@vm0/app"
  elif [[ "$file" == */packages/core/* ]];          then echo "@vm0/core"
  elif [[ "$file" == */packages/firewalls-generator/* ]]; then echo "@vm0/firewalls-generator"
  else echo ""
  fi
}

list_files() {
  case "$1" in
    web)      find "$TURBO_DIR/apps/web/src"           -name "*.test.ts" -o -name "*.test.tsx" | sort ;;
    cli)      find "$TURBO_DIR/apps/cli/src"           -name "*.test.ts" | sort ;;
    platform) find "$TURBO_DIR/apps/platform/src"     -name "*.test.ts" -o -name "*.test.tsx" | sort ;;
    core)     find "$TURBO_DIR/packages/core"          -name "*.test.ts" | sort ;;
    firewalls-generator) find "$TURBO_DIR/packages/firewalls-generator" -name "*.test.ts" | sort ;;
    all)
      list_files web
      list_files cli
      list_files platform
      list_files core
      list_files firewalls-generator
      ;;
    *)
      echo "Unknown workspace: $1" >&2
      echo "Valid: web | cli | platform | core | firewalls-generator | all" >&2
      exit 1
      ;;
  esac
}

# Parse bash TIMEFORMAT output → milliseconds
# Handles both:  "1m34.916s"  (>=60s, bash formats as NmSS.NNNs)
#            and "9.234"      (<60s,  bash outputs plain decimal seconds)
parse_time_ms() {
  local t="$1"
  if [[ "$t" == *m* ]]; then
    # "1m34.916s" → min=1, sec=34.916
    local min="${t%%m*}"
    local sec="${t#*m}"; sec="${sec%s}"
    awk -v m="$min" -v s="$sec" 'BEGIN { printf "%d", (m * 60 + s) * 1000 }'
  else
    # "9.234" or "9.234s" → just seconds
    local sec="${t%s}"
    awk -v s="$sec" 'BEGIN { printf "%d", s * 1000 }'
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────
mapfile -t FILES < <(list_files "$WORKSPACE")
TOTAL="${#FILES[@]}"

if [[ "$TOTAL" -eq 0 ]]; then
  echo "No test files found for workspace: $WORKSPACE" >&2
  exit 1
fi

echo ""
printf "${BLU}Profiling %d test files  [workspace: %s]${RST}\n" "$TOTAL" "$WORKSPACE"
printf "${DIM}Results will be saved to: %s${RST}\n\n" "$RESULTS_FILE"

# TSV header
printf "wall_ms\tuser_ms\tsys_ms\tcpu_ms\tstatus\tfile\n" > "$RESULTS_FILE"

IDX=0
FAILED_FILES=()

for FILE in "${FILES[@]}"; do
  IDX=$((IDX + 1))
  REL="${FILE#$TURBO_DIR/}"
  FILTER="$(get_filter "$FILE")"

  if [[ -z "$FILTER" ]]; then
    printf "${DIM}[%3d/%3d]${RST} SKIP  %s\n" "$IDX" "$TOTAL" "$REL"
    continue
  fi

  # Run vitest for this one file, capture timing via TIMEFORMAT
  TIMEFORMAT='%R %U %S'
  TIME_OUTPUT=""
  EXIT_CODE=0

  {
    TIME_OUTPUT="$(
      { time pnpm --dir "$TURBO_DIR" -F "$FILTER" exec vitest run --reporter=dot "$FILE" \
          1>/dev/null 2>/dev/null; } 2>&1
    )"
  } || EXIT_CODE=$?

  # TIME_OUTPUT is "real user sys" e.g. "1.234 0.456 0.123"
  read -r real_raw user_raw sys_raw <<< "$TIME_OUTPUT"

  WALL_MS="$(parse_time_ms "$real_raw")"
  USER_MS="$(parse_time_ms "$user_raw")"
  SYS_MS="$(parse_time_ms "$sys_raw")"
  CPU_MS=$((USER_MS + SYS_MS))

  STATUS="pass"
  if [[ "$EXIT_CODE" -ne 0 ]]; then
    STATUS="FAIL"
    FAILED_FILES+=("$REL")
  fi

  # Color coding
  if   [[ "$STATUS" == "FAIL" ]];   then SC="$RED"
  elif [[ "$WALL_MS" -gt 10000 ]];  then SC="$RED"
  elif [[ "$WALL_MS" -gt 5000 ]];   then SC="$YLW"
  else                                    SC="$GRN"
  fi

  printf "${DIM}[%3d/%3d]${RST} ${SC}%-4s${RST}  wall:${SC}%6dms${RST}  cpu:${SC}%6dms${RST}  %s\n" \
    "$IDX" "$TOTAL" "$STATUS" "$WALL_MS" "$CPU_MS" "$REL"

  printf "%d\t%d\t%d\t%d\t%s\t%s\n" \
    "$WALL_MS" "$USER_MS" "$SYS_MS" "$CPU_MS" "$STATUS" "$REL" >> "$RESULTS_FILE"
done

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
printf "${BLU}%s${RST}\n" "$(printf '─%.0s' {1..90})"
printf "${BLU}Top %d files by CPU time (user+sys)${RST}\n" "$TOP_N"
printf "${BLU}%s${RST}\n" "$(printf '─%.0s' {1..90})"
printf "%-10s %-10s %-10s %-6s  %s\n" "cpu_ms" "wall_ms" "user_ms" "status" "file"
printf "%s\n" "$(printf '─%.0s' {1..90})"

# Sort TSV by cpu_ms (col 4) descending, skip header, show top N
tail -n +2 "$RESULTS_FILE" \
  | sort -t$'\t' -k4 -rn \
  | head -"$TOP_N" \
  | while IFS=$'\t' read -r wall user sys cpu status file; do
      if   [[ "$status" == "FAIL" ]]; then SC="$RED"
      elif [[ "$wall" -gt 10000 ]];   then SC="$RED"
      elif [[ "$wall" -gt 5000 ]];    then SC="$YLW"
      else                                  SC="$GRN"
      fi
      printf "${SC}%-10s %-10s %-10s %-6s${RST}  %s\n" \
        "${cpu}ms" "${wall}ms" "${user}ms" "$status" "$file"
    done

printf "%s\n" "$(printf '─%.0s' {1..90})"

TOTAL_WALL=0
TOTAL_CPU=0
while IFS=$'\t' read -r wall _user _sys cpu _status _file; do
  TOTAL_WALL=$((TOTAL_WALL + wall))
  TOTAL_CPU=$((TOTAL_CPU + cpu))
done < <(tail -n +2 "$RESULTS_FILE")

printf "  Total wall: %dms  |  Total CPU: %dms  |  Files: %d\n" \
  "$TOTAL_WALL" "$TOTAL_CPU" "$TOTAL"
printf "  Full results: %s\n" "$RESULTS_FILE"
printf "  Re-sort: sort -t\$'\\t' -k1 -rn %s | head -20  (by wall time)\n" "$RESULTS_FILE"

if [[ "${#FAILED_FILES[@]}" -gt 0 ]]; then
  printf "\n${RED}Failed files (%d):${RST}\n" "${#FAILED_FILES[@]}"
  for f in "${FAILED_FILES[@]}"; do
    printf "  ${RED}✗${RST} %s\n" "$f"
  done
fi
