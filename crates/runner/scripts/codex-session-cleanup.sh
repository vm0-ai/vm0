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
old_ifs="$IFS"
IFS=/
for component in $relative_dir; do
  case "$component" in
    ""|"."|"..")
      echo "invalid codex restore path component: $component" >&2
      exit 1
      ;;
  esac
  current="$current/$component"
  check_restore_dir_component "$current"
done
IFS="$old_ifs"
if [ -d "$root" ]; then
  id="$VM0_CODEX_RESTORE_SESSION_ID"
  id_no_dashes="$(printf '%s' "$id" | tr -d '-')"
  case "$id_no_dashes" in
    ""|*[!0123456789abcdef]*)
      echo "invalid codex restore session id" >&2
      exit 1
      ;;
  esac
  if [ "${#id_no_dashes}" -ne 32 ]; then
    echo "invalid codex restore session id" >&2
    exit 1
  fi
  find "$root" \( -type f -o -type l \) \( \
    -iname "*${id}*.jsonl" -o \
    -iname "*${id}*.jsonl.zst" -o \
    -iname "*${id}*.jsonl.vm0tmp-*" -o \
    -iname "*${id}*.jsonl.zst.vm0tmp-*" -o \
    -iname "*${id_no_dashes}*.jsonl" -o \
    -iname "*${id_no_dashes}*.jsonl.zst" -o \
    -iname "*${id_no_dashes}*.jsonl.vm0tmp-*" -o \
    -iname "*${id_no_dashes}*.jsonl.zst.vm0tmp-*" \
  \) -delete
fi
