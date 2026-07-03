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

workspace_device_mounted_elsewhere() {
  [ -n "$workspace_dev" ] || return 1
  while IFS=' ' read -r _ _ mount_dev _ _ _; do
    if [ "$mount_dev" = "$workspace_dev" ]; then
      return 0
    fi
  done < /proc/self/mountinfo
  return 1
}

ensure_workspace_owner() {
  chown -h user:user -- "$workspace_dir"
}

refuse_workspace_symlink_path
workspace_dev="$(mountpoint -x -- "$workspace_device" 2>/dev/null || true)"
if mountpoint -q -- "$workspace_dir"; then
  target_dev="$(mountpoint -d -- "$workspace_dir" 2>/dev/null || true)"
  if [ -n "$workspace_dev" ] && [ "$target_dev" = "$workspace_dev" ]; then
    ensure_workspace_owner
    exit 0
  fi
  echo "refusing to mount workspace drive over existing mountpoint: $workspace_dir" >&2
  exit 64
fi

if workspace_device_mounted_elsewhere; then
  echo "refusing to mount workspace drive because $workspace_device is already mounted outside $workspace_dir" >&2
  exit 64
fi

mkdir -p -- "$workspace_dir"
refuse_workspace_symlink_path
mount -t ext4 -- "$workspace_device" "$workspace_dir"
ensure_workspace_owner
