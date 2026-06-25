set -eu

refuse_workspace_symlink_path() {
  check_path=
  remaining=${workspace_dir#/}
  while [ -n "$remaining" ]; do
    component=${remaining%%/*}
    if [ "$remaining" = "$component" ]; then
      remaining=
    else
      remaining=${remaining#*/}
    fi
    check_path="$check_path/$component"
    if [ -L "$check_path" ]; then
      echo "refusing to use symlink workspace path component: $check_path" >&2
      exit 64
    fi
  done
}

refuse_workspace_symlink_path
workspace_dev="$(mountpoint -x -- "$workspace_device" 2>/dev/null || true)"
if ! mountpoint -q -- "$workspace_dir"; then
  echo "workspace drive is not mounted: $workspace_dir" >&2
  exit 65
fi

target_dev="$(mountpoint -d -- "$workspace_dir" 2>/dev/null || true)"
if [ -z "$workspace_dev" ] || [ "$target_dev" != "$workspace_dev" ]; then
  echo "refusing to unmount non-workspace mountpoint: $workspace_dir" >&2
  exit 64
fi

cd /
sync -f -- "$workspace_dir" 2>/dev/null || true
if umount -- "$workspace_dir"; then
  exit 0
fi

WORKSPACE_HOLDER_DIAGNOSTIC_LIMIT=40
WORKSPACE_HOLDER_MAPS_LINE_LIMIT=4096
WORKSPACE_HOLDER_VALUE_LIMIT=240
WORKSPACE_HOLDER_KILL_GRACE_SECONDS=1
WORKSPACE_HOLDER_TERM_GRACE_SECONDS=1

holder_record_dir="$(mktemp -d)"
holder_records="$holder_record_dir/fast"
remaining_holder_records="$holder_record_dir/fast-remaining"
maps_holder_records="$holder_record_dir/maps"
cleanup_workspace_holder_records() {
  rm -rf -- "$holder_record_dir"
}
trap cleanup_workspace_holder_records EXIT

is_workspace_ref() {
  target=$1
  case "$target" in
    "$workspace_dir"|"$workspace_dir"/*) return 0 ;;
  esac

  deleted_suffix=" (deleted)"
  case "$target" in
    *"$deleted_suffix")
      stripped_target=${target%"$deleted_suffix"}
      case "$stripped_target" in
        "$workspace_dir"/*) return 0 ;;
      esac
      ;;
  esac

  return 1
}

proc_uid() {
  stat -c %u "/proc/$1" 2>/dev/null || true
}

proc_comm() {
  cat "/proc/$1/comm" 2>/dev/null || true
}

sanitize_log_value() {
  value="$(printf '%s' "$1" | tr '\n\t' '  ')"
  if [ "${#value}" -gt "$WORKSPACE_HOLDER_VALUE_LIMIT" ]; then
    value="$(printf '%s' "$value" | cut -c 1-"$WORKSPACE_HOLDER_VALUE_LIMIT")..."
  fi
  printf '%s' "$value"
}

scan_proc_target() {
  pid=$1
  ref_type=$2
  target=$3

  [ -n "$target" ] || return 0
  is_workspace_ref "$target" || return 0

  uid="$(proc_uid "$pid")"
  [ -n "$uid" ] || uid=unknown
  comm="$(proc_comm "$pid")"
  [ -n "$comm" ] || comm=unknown
  comm="$(sanitize_log_value "$comm")"
  target="$(sanitize_log_value "$target")"

  printf '%s\t%s\t%s\t%s\t%s\n' "$pid" "$uid" "$comm" "$ref_type" "$target"
}

scan_proc_ref() {
  pid=$1
  ref_type=$2
  ref_path=$3

  target="$(readlink -- "$ref_path" 2>/dev/null || true)"
  scan_proc_target "$pid" "$ref_type" "$target"
}

scan_proc_maps() {
  pid=$1
  maps_path=$2
  [ -r "$maps_path" ] || return 0

  truncated=0
  {
    line_count=0
    while read -r maps_address maps_perms maps_offset maps_dev maps_inode maps_target; do
      line_count=$((line_count + 1))
      if [ "$line_count" -gt "$WORKSPACE_HOLDER_MAPS_LINE_LIMIT" ]; then
        truncated=1
        break
      fi
      [ -n "$maps_target" ] || continue
      if is_workspace_ref "$maps_target"; then
        scan_proc_target "$pid" maps "$maps_target"
        return 0
      fi
    done < "$maps_path"
  } 2>/dev/null || return 0
  if [ "$truncated" -eq 1 ]; then
    echo "workspace holder maps scan truncated for pid=$pid after $WORKSPACE_HOLDER_MAPS_LINE_LIMIT lines" >&2
  fi

  return 0
}

scan_workspace_fast_holder_refs() {
  for proc_dir in /proc/[0-9]*; do
    pid=${proc_dir#/proc/}
    scan_proc_fast_holder_refs "$pid"
  done
}

scan_workspace_maps_holder_refs() {
  for proc_dir in /proc/[0-9]*; do
    pid=${proc_dir#/proc/}
    scan_proc_maps_holder_refs "$pid"
  done
}

scan_proc_fast_holder_refs() {
  pid=$1
  proc_dir="/proc/$pid"
  [ -d "$proc_dir" ] || return 0
  [ "$pid" != "$$" ] || return 0
  [ "$pid" != "1" ] || return 0

  scan_proc_ref "$pid" cwd "$proc_dir/cwd"
  scan_proc_ref "$pid" root "$proc_dir/root"
  scan_proc_ref "$pid" exe "$proc_dir/exe"
  for fd_ref in "$proc_dir"/fd/*; do
    [ -L "$fd_ref" ] || [ -e "$fd_ref" ] || continue
    scan_proc_ref "$pid" fd "$fd_ref"
  done
}

scan_proc_maps_holder_refs() {
  pid=$1
  proc_dir="/proc/$pid"
  [ -d "$proc_dir" ] || return 0
  [ "$pid" != "$$" ] || return 0
  [ "$pid" != "1" ] || return 0

  scan_proc_maps "$pid" "$proc_dir/maps"
}

workspace_fast_holder_pids() {
  for proc_dir in /proc/[0-9]*; do
    pid=${proc_dir#/proc/}
    if pid_has_fast_workspace_ref "$pid"; then
      printf '%s\n' "$pid"
    fi
  done | sort -u
}

proc_path_has_workspace_ref() {
  target="$(readlink -- "$1" 2>/dev/null || true)"
  [ -n "$target" ] || return 1
  is_workspace_ref "$target"
}

proc_maps_has_workspace_ref() {
  maps_path=$1
  [ -r "$maps_path" ] || return 1

  {
    line_count=0
    while read -r maps_address maps_perms maps_offset maps_dev maps_inode maps_target; do
      line_count=$((line_count + 1))
      [ "$line_count" -le "$WORKSPACE_HOLDER_MAPS_LINE_LIMIT" ] || return 1
      [ -n "$maps_target" ] || continue
      if is_workspace_ref "$maps_target"; then
        return 0
      fi
    done < "$maps_path"
  } 2>/dev/null || return 1

  return 1
}

pid_has_fast_workspace_ref() {
  pid=$1
  proc_dir="/proc/$pid"
  [ -d "$proc_dir" ] || return 1
  [ "$pid" != "$$" ] || return 1
  [ "$pid" != "1" ] || return 1

  if proc_path_has_workspace_ref "$proc_dir/cwd"; then
    return 0
  fi
  if proc_path_has_workspace_ref "$proc_dir/root"; then
    return 0
  fi
  if proc_path_has_workspace_ref "$proc_dir/exe"; then
    return 0
  fi
  for fd_ref in "$proc_dir"/fd/*; do
    [ -L "$fd_ref" ] || [ -e "$fd_ref" ] || continue
    if proc_path_has_workspace_ref "$fd_ref"; then
      return 0
    fi
  done

  return 1
}

pid_has_maps_workspace_ref() {
  pid=$1
  proc_dir="/proc/$pid"
  [ -d "$proc_dir" ] || return 1
  [ "$pid" != "$$" ] || return 1
  [ "$pid" != "1" ] || return 1

  if proc_maps_has_workspace_ref "$proc_dir/maps"; then
    return 0
  fi

  return 1
}

collect_and_log_workspace_holders() {
  records_file=$1
  label=$2
  : > "$records_file"
  count=0
  tab="$(printf '\t')"
  while IFS="$tab" read -r pid uid comm ref_type target; do
    count=$((count + 1))
    printf '%s\n' "$pid" >> "$records_file"
    if [ "$count" -le "$WORKSPACE_HOLDER_DIAGNOSTIC_LIMIT" ]; then
      comm="$(sanitize_log_value "$comm")"
      target="$(sanitize_log_value "$target")"
      printf 'workspace holder: phase=%s pid=%s uid=%s comm=%s ref=%s path=%s\n' \
        "$label" "$pid" "$uid" "$comm" "$ref_type" "$target" >&2
    elif [ "$count" -eq "$((WORKSPACE_HOLDER_DIAGNOSTIC_LIMIT + 1))" ]; then
      echo "workspace holder $label diagnostics truncated after $WORKSPACE_HOLDER_DIAGNOSTIC_LIMIT entries" >&2
    fi
  done
  echo "workspace holder cleanup: $label scan completed holder_ref_count=$count" >&2
}

holder_record_pids() {
  sed -n '/^[0-9][0-9]*$/p' "$1" | sort -u
}

holder_record_pid_count() {
  count="$(holder_record_pids "$1" | wc -l | tr -d ' ')"
  [ -n "$count" ] || count=0
  printf '%s' "$count"
}

term_workspace_holder_record_pids() {
  records_file=$1
  for pid in $(holder_record_pids "$records_file"); do
    [ "$pid" != "$$" ] || continue
    [ "$pid" != "1" ] || continue
    pid_has_fast_workspace_ref "$pid" || continue
    kill -TERM "$pid" 2>/dev/null || true
  done
}

kill_workspace_holder_record_pids() {
  records_file=$1
  ref_mode=$2
  for pid in $(holder_record_pids "$records_file"); do
    [ "$pid" != "$$" ] || continue
    [ "$pid" != "1" ] || continue
    case "$ref_mode" in
      fast) pid_has_fast_workspace_ref "$pid" || continue ;;
      maps) pid_has_maps_workspace_ref "$pid" || continue ;;
      *) continue ;;
    esac
    kill -KILL "$pid" 2>/dev/null || true
  done
}

wait_for_fast_workspace_holders_to_clear() {
  grace_seconds=$1
  attempts=$((grace_seconds * 10))
  [ "$attempts" -gt 0 ] || attempts=1

  while [ "$attempts" -gt 0 ]; do
    if [ -z "$(workspace_fast_holder_pids)" ]; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 0.1
  done

  [ -z "$(workspace_fast_holder_pids)" ]
}

holder_records_have_maps_workspace_ref() {
  records_file=$1
  for pid in $(holder_record_pids "$records_file"); do
    if pid_has_maps_workspace_ref "$pid"; then
      return 0
    fi
  done
  return 1
}

wait_for_maps_workspace_holders_to_clear() {
  records_file=$1
  grace_seconds=$2
  attempts=$((grace_seconds * 10))
  [ "$attempts" -gt 0 ] || attempts=1

  while [ "$attempts" -gt 0 ]; do
    if ! holder_records_have_maps_workspace_ref "$records_file"; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 0.1
  done

  ! holder_records_have_maps_workspace_ref "$records_file"
}

retry_workspace_unmount() {
  stage=$1
  echo "workspace holder cleanup: retry umount after $stage started" >&2
  sync -f -- "$workspace_dir" 2>/dev/null || true
  if umount -- "$workspace_dir"; then
    echo "workspace holder cleanup: retry umount after $stage succeeded" >&2
    return 0
  else
    status=$?
    echo "workspace holder cleanup: retry umount after $stage failed exit_code=$status" >&2
    return "$status"
  fi
}

echo "workspace drive unmount failed; diagnosing holders under $workspace_dir" >&2
echo "workspace holder cleanup: fast scan started" >&2
scan_workspace_fast_holder_refs | collect_and_log_workspace_holders "$holder_records" fast
holder_pid_count="$(holder_record_pid_count "$holder_records")"
echo "workspace holder cleanup: fast scan holder_pid_count=$holder_pid_count" >&2
if [ "$holder_pid_count" -eq 0 ]; then
  echo "no fast workspace holder processes found" >&2
else
  echo "workspace holder cleanup: TERM started holder_pid_count=$holder_pid_count" >&2
  term_workspace_holder_record_pids "$holder_records"
  wait_for_fast_workspace_holders_to_clear "$WORKSPACE_HOLDER_TERM_GRACE_SECONDS" || true
  echo "workspace holder cleanup: TERM completed" >&2
fi

if retry_workspace_unmount "fast cleanup"; then
  exit 0
fi

echo "workspace holder cleanup: fast rescan started" >&2
scan_workspace_fast_holder_refs | collect_and_log_workspace_holders "$remaining_holder_records" fast-remaining
remaining_holder_pid_count="$(holder_record_pid_count "$remaining_holder_records")"
echo "workspace holder cleanup: fast rescan holder_pid_count=$remaining_holder_pid_count" >&2
if [ "$remaining_holder_pid_count" -gt 0 ]; then
  echo "workspace holder cleanup: KILL started holder_pid_count=$remaining_holder_pid_count" >&2
  kill_workspace_holder_record_pids "$remaining_holder_records" fast
  wait_for_fast_workspace_holders_to_clear "$WORKSPACE_HOLDER_KILL_GRACE_SECONDS" || true
  echo "workspace holder cleanup: KILL completed" >&2

  if retry_workspace_unmount "fast KILL cleanup"; then
    exit 0
  fi
else
  echo "no remaining fast workspace holder processes found" >&2
fi

echo "workspace holder cleanup: slow maps scan started" >&2
scan_workspace_maps_holder_refs | collect_and_log_workspace_holders "$maps_holder_records" maps
maps_holder_pid_count="$(holder_record_pid_count "$maps_holder_records")"
echo "workspace holder cleanup: slow maps scan holder_pid_count=$maps_holder_pid_count" >&2
if [ "$maps_holder_pid_count" -gt 0 ]; then
  echo "workspace holder cleanup: maps KILL started holder_pid_count=$maps_holder_pid_count" >&2
  kill_workspace_holder_record_pids "$maps_holder_records" maps
  wait_for_maps_workspace_holders_to_clear "$maps_holder_records" "$WORKSPACE_HOLDER_KILL_GRACE_SECONDS" || true
  echo "workspace holder cleanup: maps KILL completed" >&2
else
  echo "no workspace maps holder processes found" >&2
fi

retry_workspace_unmount "slow maps diagnostics"
