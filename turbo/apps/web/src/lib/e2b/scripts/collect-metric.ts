/**
 * Metrics collection script for sandbox resource monitoring
 * Collects CPU, memory, and disk usage every 5 seconds
 * Writes metrics to /var/log/vm0/metrics.jsonl
 */
export const COLLECT_METRIC_SCRIPT = `#!/bin/bash
# Metrics collector - runs in background, writes to metrics.jsonl

LOG_SCRIPT_NAME="collect-metric"
SCRIPT_DIR="$(dirname "$0")"
source "\${SCRIPT_DIR}/common.sh"
source "\${SCRIPT_DIR}/log.sh"

# Log directory
LOG_DIR="/var/log/vm0"
METRICS_FILE="\${LOG_DIR}/metrics.jsonl"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

log_info "Starting metrics collection (interval: 5s)"

collect_metrics() {
  while true; do
    # Get timestamp
    ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

    # Collect CPU usage (user + system)
    # Use /proc/stat for more reliable CPU measurement
    cpu_line=$(head -1 /proc/stat)
    cpu_user=$(echo "$cpu_line" | awk '{print $2}')
    cpu_nice=$(echo "$cpu_line" | awk '{print $3}')
    cpu_system=$(echo "$cpu_line" | awk '{print $4}')
    cpu_idle=$(echo "$cpu_line" | awk '{print $5}')
    cpu_total=$((cpu_user + cpu_nice + cpu_system + cpu_idle))

    # Calculate CPU percentage (simplified: use current snapshot)
    # For more accurate measurement, we'd need to compare with previous reading
    if [ $cpu_total -gt 0 ]; then
      cpu_used=$((cpu_user + cpu_nice + cpu_system))
      cpu_pct=$(awk "BEGIN {printf "%.1f", ($cpu_used / $cpu_total) * 100}")
    else
      cpu_pct="0.0"
    fi

    # Collect memory usage from /proc/meminfo (more reliable than free)
    mem_total=$(awk '/MemTotal:/ {print $2 * 1024}' /proc/meminfo)
    mem_available=$(awk '/MemAvailable:/ {print $2 * 1024}' /proc/meminfo)
    mem_used=$((mem_total - mem_available))

    # Collect disk usage
    disk_info=$(df -B1 / 2>/dev/null | awk 'NR==2 {print $3, $2}')
    disk_used=$(echo "$disk_info" | awk '{print $1}')
    disk_total=$(echo "$disk_info" | awk '{print $2}')

    # Default values if parsing failed
    disk_used=\${disk_used:-0}
    disk_total=\${disk_total:-0}

    # Write metrics as JSON line
    echo '{"ts":"'"$ts"'","cpu":'"$cpu_pct"',"mem_used":'"$mem_used"',"mem_total":'"$mem_total"',"disk_used":'"$disk_used"',"disk_total":'"$disk_total"'}' >> "$METRICS_FILE"

    sleep 5
  done
}

# Run metrics collection
collect_metrics
`;
