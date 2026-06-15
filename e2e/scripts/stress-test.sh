#!/bin/bash
# Runner stress test driver
# Submits N concurrent jobs via `vm0 run`, waits for all to complete, and reports metrics.
#
# Prerequisites:
#   - VM0_API_URL: Vercel preview URL (set in ~/.vm0/config.json via test token)
#   - Agent already created via `vm0 compose`
#
# Usage: ./stress-test.sh <agent_name> <job_count> <prompt> <timeout_minutes> <total_capacity>

set -euo pipefail

AGENT_NAME="${1:?Error: agent_name is required}"
JOB_COUNT="${2:?Error: job_count is required}"
PROMPT="${3:?Error: prompt is required}"
TIMEOUT_MINUTES="${4:?Error: timeout_minutes is required}"
TOTAL_CAPACITY="${5:?Error: total_capacity is required}"

TIMEOUT_SECONDS=$((TIMEOUT_MINUTES * 60))
START_TIME=$(date +%s)

# Temporary directory for job tracking
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "=== Runner Stress Test ==="
echo "  Agent:    ${AGENT_NAME}"
echo "  Jobs:     ${JOB_COUNT}"
echo "  Prompt:   ${PROMPT}"
echo "  Timeout:  ${TIMEOUT_MINUTES}m"
echo "  Capacity: ${TOTAL_CAPACITY}"
echo ""

# --- Run jobs ---
echo "=== Launching ${JOB_COUNT} concurrent vm0 run commands ==="

run_job() {
  local index=$1
  local job_start
  job_start=$(date +%s)

  # vm0 run blocks until completion, captures output and exit code
  local output exit_code=0
  output=$(timeout "${TIMEOUT_SECONDS}" vm0 run "$AGENT_NAME" "$PROMPT" 2>&1) || exit_code=$?

  local job_end
  job_end=$(date +%s)
  local duration=$((job_end - job_start))

  # Determine status from exit code
  local status
  if [[ "$exit_code" -eq 0 ]]; then
    status="completed"
  elif [[ "$exit_code" -eq 124 ]]; then
    status="timed_out"
  else
    status="failed"
  fi

  # Save results
  echo "$status" > "${WORK_DIR}/job-${index}.status"
  echo "$duration" > "${WORK_DIR}/job-${index}.duration"
  echo "$output" > "${WORK_DIR}/job-${index}.output"

  echo "[${index}/${JOB_COUNT}] ${status} (${duration}s)"
}

PIDS=()
for i in $(seq 1 "$JOB_COUNT"); do
  run_job "$i" &
  PIDS+=($!)
done

echo "All ${JOB_COUNT} jobs launched, waiting for completion..."
echo ""

# Wait for all jobs
for pid in "${PIDS[@]}"; do
  wait "$pid" || true
done

# --- Collect results ---
echo ""
echo "=== Generating report ==="

TOTAL_DURATION=$(( $(date +%s) - START_TIME ))
COMPLETED=0
FAILED=0
TIMED_OUT=0
DURATIONS=()

for i in $(seq 1 "$JOB_COUNT"); do
  status=$(cat "${WORK_DIR}/job-${i}.status" 2>/dev/null || echo "unknown")
  case "$status" in
    completed) COMPLETED=$((COMPLETED + 1)) ;;
    failed) FAILED=$((FAILED + 1)) ;;
    timed_out) TIMED_OUT=$((TIMED_OUT + 1)) ;;
  esac

  if [[ -f "${WORK_DIR}/job-${i}.duration" ]]; then
    DURATIONS+=("$(cat "${WORK_DIR}/job-${i}.duration")")
  fi
done

# Helper: compute stats from an array of numbers
compute_stats() {
  local -n arr=$1
  local count=${#arr[@]}
  if [[ "$count" -eq 0 ]]; then
    echo "n/a|n/a|n/a|n/a"
    return
  fi

  IFS=$'\n' sorted=($(sort -n <<< "${arr[*]}")); unset IFS

  local sum=0
  for v in "${sorted[@]}"; do
    sum=$((sum + v))
  done
  local avg=$((sum / count))
  local min=${sorted[0]}
  local max=${sorted[$((count - 1))]}
  local p50_idx=$(( (count - 1) / 2 ))
  local p50=${sorted[$p50_idx]}

  echo "${avg}|${min}|${max}|${p50}"
}

DUR_STATS=$(compute_stats DURATIONS)
IFS='|' read -r D_AVG D_MIN D_MAX D_P50 <<< "$DUR_STATS"

# Print failed job outputs for debugging
if [[ "$FAILED" -gt 0 ]] || [[ "$TIMED_OUT" -gt 0 ]]; then
  echo ""
  echo "=== Failed/Timed-out job outputs ==="
  for i in $(seq 1 "$JOB_COUNT"); do
    status=$(cat "${WORK_DIR}/job-${i}.status" 2>/dev/null || echo "unknown")
    if [[ "$status" == "failed" ]] || [[ "$status" == "timed_out" ]]; then
      echo "--- Job ${i} (${status}) ---"
      tail -20 "${WORK_DIR}/job-${i}.output" 2>/dev/null || true
      echo ""
    fi
  done
fi

# Write GitHub Actions step summary
cat >> "$GITHUB_STEP_SUMMARY" << EOF
## Runner Stress Test Results

### Summary
| Metric | Value |
|--------|-------|
| Jobs | ${JOB_COUNT} |
| Completed | ${COMPLETED} |
| Failed | ${FAILED} |
| Timed Out | ${TIMED_OUT} |
| Total Wall Time | ${TOTAL_DURATION}s |
| Runner Capacity | ${TOTAL_CAPACITY} |

### Per-Job Duration (end-to-end, including queue time)
| Stat | Value |
|------|-------|
| Avg | ${D_AVG}s |
| Min | ${D_MIN}s |
| Max | ${D_MAX}s |
| p50 | ${D_P50}s |

### Configuration
- Agent: \`${AGENT_NAME}\`
- Prompt: \`${PROMPT}\`
- Runner capacity: ${TOTAL_CAPACITY}
- Timeout: ${TIMEOUT_MINUTES}m
EOF

echo ""
echo "=== Stress Test Complete ==="
echo "  Jobs:      ${JOB_COUNT}"
echo "  Completed: ${COMPLETED}"
echo "  Failed:    ${FAILED}"
echo "  Timed Out: ${TIMED_OUT}"
echo "  Wall Time: ${TOTAL_DURATION}s"
echo "  Per-job:   avg=${D_AVG}s min=${D_MIN}s max=${D_MAX}s p50=${D_P50}s"
echo ""

if [[ "$FAILED" -gt 0 ]] || [[ "$TIMED_OUT" -gt 0 ]]; then
  echo "::error::Stress test had failures: ${FAILED} failed, ${TIMED_OUT} timed out"
  exit 1
fi

echo "All jobs completed successfully"
