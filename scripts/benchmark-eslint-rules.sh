#!/usr/bin/env bash
# Ablation benchmark for @vm0/app ESLint rules.
#
# Phase 1 — TIMING=1 run to see per-rule wall-clock cost (single run).
# Phase 2 — baseline RSS (N runs, all rules, default config).
# Phase 3 — disable each type-aware rule individually (N runs each).
# Phase 4 — remove projectService entirely (N runs).
#
# Usage: ./scripts/benchmark-eslint-rules.sh [runs-per-experiment]
# Default: 3 runs per experiment.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM_DIR="$REPO_ROOT/turbo/apps/platform"
RUNS="${1:-3}"

# Type-aware rules ordered by timing cost (Phase 1 result)
TYPE_AWARE_RULES=(
  "ccstate/computed-const-args-package-scope"
  "ccstate/no-package-variable"
  "ccstate/no-getter-setter-params"
  "ccstate/no-store-in-params"
  "ccstate/command-async-signal"
  "ccstate/no-get-signal"
)

# ─── helpers ────────────────────────────────────────────────────────────────

# tree_rss <pid>  — sum VmRSS across a process and ALL its descendants
tree_rss() {
  local root="$1"
  local total=0
  local queue=("$root")
  local visited=()

  while (( ${#queue[@]} > 0 )); do
    local pid="${queue[0]}"
    queue=("${queue[@]:1}")

    # skip if already visited
    local seen=0
    for v in "${visited[@]:-}"; do [[ "$v" == "$pid" ]] && seen=1 && break; done
    (( seen )) && continue
    visited+=("$pid")

    local kb
    kb=$(awk '/^VmRSS/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)
    kb=${kb:-0}
    (( total += kb ))

    # enqueue children
    local children
    children=$(pgrep -P "$pid" 2>/dev/null || true)
    for child in $children; do
      queue+=("$child")
    done
  done

  echo "$total"
}

# peak_rss_of_tree <pid>  — poll every 100 ms, return max tree RSS in kB
peak_rss_of_tree() {
  local pid="$1"
  local max_kb=0
  while kill -0 "$pid" 2>/dev/null; do
    local kb
    kb=$(tree_rss "$pid")
    (( kb > max_kb )) && max_kb=$kb
    sleep 0.1
  done
  echo "$max_kb"
}

# python_stats <v1> [v2 ...]  — prints "avg stddev"
python_stats() {
  python3 -c "
import statistics, sys
v = list(map(float, sys.argv[1:]))
avg = statistics.mean(v)
std = statistics.stdev(v) if len(v) > 1 else 0.0
print(round(avg, 1), round(std, 1))
" "$@"
}

# measure <label> <env-exports> <extra-eslint-args>
measure() {
  local label="$1"
  local env_exports="$2"
  local extra_args="${3:-}"

  local rss_vals=()
  local time_vals=()

  for (( i = 1; i <= RUNS; i++ )); do
    local start_ns
    start_ns=$(date +%s%N)

    # Launch ESLint in a dedicated bash child so we can track its entire tree
    bash -c "cd '$PLATFORM_DIR' && $env_exports pnpm exec eslint . \
        --max-warnings 0 $extra_args" >/dev/null 2>&1 &
    local eslint_pid=$!

    local peak_kb
    peak_kb=$(peak_rss_of_tree "$eslint_pid")
    wait "$eslint_pid"

    local end_ns elapsed_ms
    end_ns=$(date +%s%N)
    elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))

    rss_vals+=( $(( peak_kb / 1024 )) )
    time_vals+=( "$elapsed_ms" )
  done

  local rss_stats time_stats
  rss_stats=$(python_stats "${rss_vals[@]}")
  time_stats=$(python_stats "${time_vals[@]}")

  local rss_avg rss_std time_avg time_std
  read -r rss_avg rss_std <<< "$rss_stats"
  read -r time_avg time_std <<< "$time_stats"

  printf "%-54s  RSS %6s ± %-5s MB   time %6s ± %s ms\n" \
    "$label" "$rss_avg" "$rss_std" "$time_avg" "$time_std"
}

# ─── Phase 1: timing run ─────────────────────────────────────────────────────

echo "════════════════════════════════════════════════════════════════"
echo "Phase 1 — TIMING=1 (single run, per-rule wall-clock)"
echo "════════════════════════════════════════════════════════════════"
(
  cd "$PLATFORM_DIR"
  TIMING=1 pnpm exec eslint . --max-warnings 0 2>&1 \
    | grep -E "^Rule|^-|ccstate|typescript" \
    | head -40
)
echo ""

# ─── Phase 2: baseline ───────────────────────────────────────────────────────

echo "════════════════════════════════════════════════════════════════"
echo "Phase 2 — Baseline (all rules, $RUNS runs)"
echo "════════════════════════════════════════════════════════════════"
measure "baseline (all rules)" "" ""
echo ""

# ─── Phase 3: disable each type-aware rule one at a time ─────────────────────

echo "════════════════════════════════════════════════════════════════"
echo "Phase 3 — Disable one type-aware rule at a time ($RUNS runs each)"
echo "════════════════════════════════════════════════════════════════"
for rule in "${TYPE_AWARE_RULES[@]}"; do
  measure "disable $rule" \
    "DISABLED_RULES=$rule" \
    "--config eslint.config.ablation.mjs"
done
echo ""

# ─── Phase 4: remove projectService entirely ─────────────────────────────────

echo "════════════════════════════════════════════════════════════════"
echo "Phase 4 — Remove projectService entirely ($RUNS runs)"
echo "════════════════════════════════════════════════════════════════"
measure "no projectService (all type-aware rules off)" \
  "REMOVE_PROJECT_SERVICE=1" \
  "--config eslint.config.ablation.mjs"
echo ""

echo "Done."
