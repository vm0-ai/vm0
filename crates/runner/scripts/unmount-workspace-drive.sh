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
WORKSPACE_HOLDER_VALUE_LIMIT=240
WORKSPACE_HOLDER_KILL_GRACE_SECONDS=1
WORKSPACE_HOLDER_TERM_GRACE_SECONDS=1

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

  {
    while read -r maps_address maps_perms maps_offset maps_dev maps_inode maps_target; do
      [ -n "$maps_target" ] || continue
      if is_workspace_ref "$maps_target"; then
        scan_proc_target "$pid" maps "$maps_target"
        return 0
      fi
    done < "$maps_path"
  } 2>/dev/null || return 0

  return 0
}

scan_workspace_holder_refs() {
  for proc_dir in /proc/[0-9]*; do
    pid=${proc_dir#/proc/}
    scan_proc_holder_refs "$pid"
  done
}

scan_proc_holder_refs() {
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
  scan_proc_maps "$pid" "$proc_dir/maps"
}

workspace_holder_pids() {
  for proc_dir in /proc/[0-9]*; do
    pid=${proc_dir#/proc/}
    if pid_has_workspace_ref "$pid"; then
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
    while read -r maps_address maps_perms maps_offset maps_dev maps_inode maps_target; do
      [ -n "$maps_target" ] || continue
      if is_workspace_ref "$maps_target"; then
        return 0
      fi
    done < "$maps_path"
  } 2>/dev/null || return 1

  return 1
}

pid_has_workspace_ref() {
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
  if proc_maps_has_workspace_ref "$proc_dir/maps"; then
    return 0
  fi

  return 1
}

log_workspace_holders() {
  count=0
  tab="$(printf '\t')"
  scan_workspace_holder_refs | while IFS="$tab" read -r pid uid comm ref_type target; do
    count=$((count + 1))
    if [ "$count" -le "$WORKSPACE_HOLDER_DIAGNOSTIC_LIMIT" ]; then
      comm="$(sanitize_log_value "$comm")"
      target="$(sanitize_log_value "$target")"
      printf 'workspace holder: pid=%s uid=%s comm=%s ref=%s path=%s\n' \
        "$pid" "$uid" "$comm" "$ref_type" "$target" >&2
    elif [ "$count" -eq "$((WORKSPACE_HOLDER_DIAGNOSTIC_LIMIT + 1))" ]; then
      echo "workspace holder diagnostics truncated after $WORKSPACE_HOLDER_DIAGNOSTIC_LIMIT entries" >&2
    fi
  done
}

term_workspace_holder_pids() {
  pids=$1
  for pid in $pids; do
    [ "$pid" != "$$" ] || continue
    [ "$pid" != "1" ] || continue
    pid_has_workspace_ref "$pid" || continue
    kill -TERM "$pid" 2>/dev/null || true
  done
}

kill_workspace_holder_pids() {
  pids=$1
  for pid in $pids; do
    [ "$pid" != "$$" ] || continue
    [ "$pid" != "1" ] || continue
    pid_has_workspace_ref "$pid" || continue
    kill -KILL "$pid" 2>/dev/null || true
  done
}

echo "workspace drive unmount failed; diagnosing holders under $workspace_dir" >&2
holder_pids="$(workspace_holder_pids)"
if [ -z "$holder_pids" ]; then
  echo "no workspace holder processes found" >&2
else
  log_workspace_holders
  term_workspace_holder_pids "$holder_pids"
  sleep "$WORKSPACE_HOLDER_TERM_GRACE_SECONDS"

  remaining_holder_pids="$(workspace_holder_pids)"
  if [ -n "$remaining_holder_pids" ]; then
    echo "workspace holders remain after TERM; sending KILL" >&2
    log_workspace_holders
    kill_workspace_holder_pids "$remaining_holder_pids"
    sleep "$WORKSPACE_HOLDER_KILL_GRACE_SECONDS"
  fi
fi

sync -f -- "$workspace_dir" 2>/dev/null || true
umount -- "$workspace_dir"
