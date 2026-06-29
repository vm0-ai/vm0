root="$codex_home/sessions"
restore_path="$VM0_CODEX_RESTORE_SESSION_PATH"
restore_dir="${restore_path%/*}"
case "$restore_dir" in
  "$root"/*/*/*) ;;
  *)
    echo "invalid codex restore directory: $restore_dir" >&2
    exit 1
    ;;
esac
check_restore_dir_component() {
  path="$1"
  if [ -L "$path" ]; then
    echo "codex restore directory is a symlink: $path" >&2
    exit 1
  fi
  if [ -e "$path" ] && [ ! -d "$path" ]; then
    echo "codex restore path component is not a directory: $path" >&2
    exit 1
  fi
}
check_restore_dir_component "$codex_home"
check_restore_dir_component "$root"
root_prefix="$root/"
relative_dir="${restore_dir#$root_prefix}"
current="$root"
remaining="$relative_dir"
while [ -n "$remaining" ]; do
  component="${remaining%%/*}"
  if [ "$component" = "$remaining" ]; then
    remaining=""
  else
    remaining="${remaining#*/}"
  fi
  case "$component" in
    ""|"."|"..")
      echo "invalid codex restore path component: $component" >&2
      exit 1
      ;;
  esac
  current="$current/$component"
  check_restore_dir_component "$current"
done
id="$VM0_CODEX_RESTORE_SESSION_ID"
case "$id" in
  ""|*[!0123456789abcdefABCDEF-]*)
    echo "invalid codex restore session id" >&2
    exit 1
    ;;
esac
if [ "${#id}" -ne 36 ]; then
  echo "invalid codex restore session id" >&2
  exit 1
fi
id_no_dashes="$VM0_CODEX_RESTORE_SESSION_FILENAME_KEY"
case "$id_no_dashes" in
  ""|*[!0123456789abcdefABCDEF]*)
    echo "invalid codex restore session id" >&2
    exit 1
    ;;
esac
if [ "${#id_no_dashes}" -ne 32 ]; then
  echo "invalid codex restore session id" >&2
  exit 1
fi
scan_budget="${VM0_CODEX_SESSION_CLEANUP_SCAN_BUDGET:-16384}"
case "$scan_budget" in
  ""|*[!0123456789]*)
    echo "invalid codex session cleanup scan budget" >&2
    exit 1
    ;;
esac
case "$scan_budget" in
  ???????*)
    echo "invalid codex session cleanup scan budget" >&2
    exit 1
    ;;
esac
if [ "$scan_budget" -eq 0 ]; then
  echo "invalid codex session cleanup scan budget" >&2
  exit 1
fi
id_lc=$(printf '%s' "$id" | tr '[:upper:]' '[:lower:]')
id_no_dashes_lc=$(printf '%s' "$id_no_dashes" | tr '[:upper:]' '[:lower:]')
scanned_entries=0
check_scan_budget() {
  scanned_entries=$((scanned_entries + 1))
  if [ "$scanned_entries" -gt "$scan_budget" ]; then
    echo "codex session cleanup exceeded scan budget" >&2
    exit 1
  fi
}
ensure_scannable_session_dir() {
  dir="$1"
  if [ ! -r "$dir" ] || [ ! -x "$dir" ]; then
    echo "cannot scan codex session directory" >&2
    exit 1
  fi
}
session_filename_matches() {
  name="${1##*/}"
  case "$name" in
    *[ABCDEFGHIJKLMNOPQRSTUVWXYZ]*)
      name=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
      ;;
  esac
  case "$name" in
    *"$id_lc"*.jsonl|\
    *"$id_lc"*.jsonl.zst|\
    *"$id_lc"*.jsonl.vm0tmp-*|\
    *"$id_lc"*.jsonl.zst.vm0tmp-*|\
    *"$id_no_dashes_lc"*.jsonl|\
    *"$id_no_dashes_lc"*.jsonl.zst|\
    *"$id_no_dashes_lc"*.jsonl.vm0tmp-*|\
    *"$id_no_dashes_lc"*.jsonl.zst.vm0tmp-*)
      return 0
      ;;
  esac
  return 1
}
delete_matching_session_entry() {
  path="$1"
  if [ ! -f "$path" ] && [ ! -L "$path" ]; then
    return
  fi
  if session_filename_matches "$path"; then
    rm -f -- "$path" || {
      echo "failed to delete codex session file" >&2
      exit 1
    }
  fi
}
# Codex resume can see matching session files anywhere below sessions; the
# explicit entry budget keeps that required duplicate cleanup bounded.
scan_session_tree() {
  dir="$1"
  action="$2"
  ensure_scannable_session_dir "$dir"
  for path in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then
      continue
    fi
    check_scan_budget
    case "$action" in
      delete)
        delete_matching_session_entry "$path"
        ;;
    esac
    if [ -d "$path" ] && [ ! -L "$path" ]; then
      scan_session_tree "$path" "$action"
    fi
  done
}
if [ -d "$root" ]; then
  scan_session_tree "$root" validate
  scanned_entries=0
  scan_session_tree "$root" delete
fi
