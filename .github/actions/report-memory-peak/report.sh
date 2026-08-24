#!/usr/bin/env bash
set -euo pipefail

cgroup_root=${OKOU_CGROUP_ROOT:-/sys/fs/cgroup}
proc_cgroup=${OKOU_PROC_CGROUP:-/proc/self/cgroup}
job_label=${OKOU_MEMORY_REPORT_LABEL:-${GITHUB_JOB:-CI}}

peak_bytes=""
peak_source=""

read_peak() {
  local source=$1 path=$2 value

  [ -r "$path" ] || return 1
  value=$(<"$path")
  [[ "$value" =~ ^[0-9]+$ ]] || return 1

  peak_bytes=$value
  peak_source=$source
  return 0
}

v2_path=""
v1_path=""
if [ -r "$proc_cgroup" ]; then
  v2_path=$(awk -F: '$1 == "0" { print $3; exit }' "$proc_cgroup")
  v1_path=$(awk -F: '$2 ~ /(^|,)memory(,|$)/ { print $3; exit }' "$proc_cgroup")
fi

if [ -n "$v2_path" ]; then
  read_peak "cgroup v2 memory.peak" "${cgroup_root}${v2_path%/}/memory.peak" || true
fi
if [ -z "$peak_bytes" ]; then
  read_peak "cgroup v2 memory.peak" "${cgroup_root}/memory.peak" || true
fi

if [ -z "$peak_bytes" ] && [ -n "$v1_path" ]; then
  read_peak \
    "cgroup v1 memory.max_usage_in_bytes" \
    "${cgroup_root}/memory${v1_path%/}/memory.max_usage_in_bytes" || true
  if [ -z "$peak_bytes" ]; then
    read_peak \
      "cgroup v1 memory.max_usage_in_bytes" \
      "${cgroup_root}${v1_path%/}/memory.max_usage_in_bytes" || true
  fi
fi
if [ -z "$peak_bytes" ]; then
  read_peak \
    "cgroup v1 memory.max_usage_in_bytes" \
    "${cgroup_root}/memory/memory.max_usage_in_bytes" || true
fi
if [ -z "$peak_bytes" ]; then
  read_peak \
    "cgroup v1 memory.max_usage_in_bytes" \
    "${cgroup_root}/memory.max_usage_in_bytes" || true
fi

append_summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0

  if ! {
    printf '### CI peak memory\n\n'
    printf -- '- Job: \140%s\140\n' "$job_label"
    if [ -n "$peak_bytes" ]; then
      printf -- '- Peak memory: **%s MiB** (\140%s bytes\140)\n' "$peak_mib" "$peak_bytes"
      printf -- '- Source: \140%s\140\n\n' "$peak_source"
    else
      printf -- '- Peak memory: unavailable (no supported readable cgroup metric)\n\n'
    fi
  } >> "$GITHUB_STEP_SUMMARY"; then
    echo "::notice::Could not append peak memory to the job summary"
  fi
}

if [ -z "$peak_bytes" ]; then
  echo "::notice::Peak memory (${job_label}) unavailable: no supported readable cgroup metric"
  append_summary
  exit 0
fi

mib_whole=$((peak_bytes / 1048576))
mib_remainder=$((peak_bytes % 1048576))
mib_tenth=$(((mib_remainder * 10 + 524288) / 1048576))
if [ "$mib_tenth" -eq 10 ]; then
  mib_whole=$((mib_whole + 1))
  mib_tenth=0
fi
peak_mib="${mib_whole}.${mib_tenth}"

echo "Peak memory (${job_label}): ${peak_mib} MiB (${peak_bytes} bytes; ${peak_source})"
append_summary
