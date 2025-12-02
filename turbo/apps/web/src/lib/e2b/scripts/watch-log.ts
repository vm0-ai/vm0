/**
 * Log watcher script for batch uploading metrics and errors
 * Watches /var/log/vm0/metrics.jsonl and errors.log
 * Uploads in batches every 5 seconds to reduce API calls
 */
export const WATCH_LOG_SCRIPT = `#!/bin/bash
# Log watcher - batch uploads metrics and errors every 5 seconds

LOG_SCRIPT_NAME="watch-log"
SCRIPT_DIR="$(dirname "$0")"
source "\${SCRIPT_DIR}/common.sh"
source "\${SCRIPT_DIR}/log.sh"
source "\${SCRIPT_DIR}/request.sh"

# Log files
LOG_DIR="/var/log/vm0"
METRICS_FILE="\${LOG_DIR}/metrics.jsonl"
ERRORS_FILE="\${LOG_DIR}/errors.log"

# Position tracking files
METRICS_POS_FILE="/tmp/vm0-metrics-pos-$RUN_ID"
ERRORS_POS_FILE="/tmp/vm0-errors-pos-$RUN_ID"

# Metrics webhook URL
METRICS_WEBHOOK_URL="\${API_URL}/api/webhooks/agent/metrics"

log_info "Starting log watcher (batch interval: 5s)"

# Initialize position files
echo "0" > "$METRICS_POS_FILE"
echo "0" > "$ERRORS_POS_FILE"

# Read new lines from file since last position
# Usage: read_new_lines <file> <pos_file>
# Outputs: new lines, updates position file
read_new_lines() {
  local file="$1"
  local pos_file="$2"

  if [ ! -f "$file" ]; then
    return
  fi

  local last_pos=$(cat "$pos_file" 2>/dev/null || echo "0")
  local current_size=$(stat -c %s "$file" 2>/dev/null || echo "0")

  if [ "$current_size" -gt "$last_pos" ]; then
    # Read new content from last position
    tail -c +$((last_pos + 1)) "$file" 2>/dev/null
    # Update position
    echo "$current_size" > "$pos_file"
  fi
}

# Build JSON array from lines
# Usage: echo "line1\nline2" | build_json_array
build_metrics_array() {
  local result="["
  local first=true

  while IFS= read -r line; do
    if [ -z "$line" ]; then
      continue
    fi

    # Validate JSON
    if ! echo "$line" | jq empty 2>/dev/null; then
      continue
    fi

    if [ "$first" = true ]; then
      result="$result$line"
      first=false
    else
      result="$result,$line"
    fi
  done

  result="$result]"
  echo "$result"
}

# Build JSON array of strings from lines
build_errors_array() {
  local result="["
  local first=true

  while IFS= read -r line; do
    if [ -z "$line" ]; then
      continue
    fi

    # Escape the line for JSON
    local escaped=$(echo "$line" | jq -R .)

    if [ "$first" = true ]; then
      result="$result$escaped"
      first=false
    else
      result="$result,$escaped"
    fi
  done

  result="$result]"
  echo "$result"
}

# Upload batch of metrics and errors
upload_batch() {
  local metrics_json="[]"
  local errors_json="[]"
  local has_data=false

  # Read new metrics
  local new_metrics=$(read_new_lines "$METRICS_FILE" "$METRICS_POS_FILE")
  if [ -n "$new_metrics" ]; then
    metrics_json=$(echo "$new_metrics" | build_metrics_array)
    if [ "$metrics_json" != "[]" ]; then
      has_data=true
    fi
  fi

  # Read new errors
  local new_errors=$(read_new_lines "$ERRORS_FILE" "$ERRORS_POS_FILE")
  if [ -n "$new_errors" ]; then
    errors_json=$(echo "$new_errors" | build_errors_array)
    if [ "$errors_json" != "[]" ]; then
      has_data=true
    fi
  fi

  # Skip if no new data
  if [ "$has_data" = false ]; then
    return 0
  fi

  # Build payload
  local payload=$(jq -n \\
    --arg runId "$RUN_ID" \\
    --argjson metrics "$metrics_json" \\
    --argjson errors "$errors_json" \\
    '{runId: $runId, metrics: $metrics, errors: $errors}')

  # Upload to webhook
  if http_post_json "$METRICS_WEBHOOK_URL" "$payload" >/dev/null; then
    log_debug "Uploaded batch: metrics=$(echo "$metrics_json" | jq length), errors=$(echo "$errors_json" | jq length)"
  else
    log_warn "Failed to upload batch"
  fi
}

# Final flush - upload any remaining data
final_flush() {
  log_info "Performing final flush"
  upload_batch
  log_info "Final flush complete"
}

# Trap for cleanup
trap final_flush EXIT

# Main loop
watch_logs() {
  while true; do
    upload_batch
    sleep 5
  done
}

# Run watcher
watch_logs
`;
