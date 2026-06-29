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
id_lc=$(printf '%s' "$id" | tr '[:upper:]' '[:lower:]') || {
  echo "failed to normalize codex restore session id" >&2
  exit 1
}
id_no_dashes_lc=$(printf '%s' "$id_no_dashes" | tr '[:upper:]' '[:lower:]') || {
  echo "failed to normalize codex restore session id" >&2
  exit 1
}
if [ "${#id_lc}" -ne 36 ] || [ "${#id_no_dashes_lc}" -ne 32 ]; then
  echo "failed to normalize codex restore session id" >&2
  exit 1
fi
# Codex resume can see matching session files anywhere below sessions; the
# explicit entry budget keeps that required duplicate cleanup bounded.
scan_error_file=""
matching_entries_file=""
cleanup_scan_error_file() {
  if [ -n "$scan_error_file" ]; then
    rm -f -- "$scan_error_file"
  fi
  if [ -n "$matching_entries_file" ]; then
    rm -f -- "$matching_entries_file"
  fi
}
cleanup_scan_error_file_and_exit() {
  cleanup_scan_error_file
  exit 1
}
trap cleanup_scan_error_file EXIT
trap cleanup_scan_error_file_and_exit HUP INT TERM
collect_matching_session_entries() {
  : > "$scan_error_file" || {
    echo "failed to reset codex session cleanup temp file" >&2
    exit 1
  }
  : > "$matching_entries_file" || {
    echo "failed to reset codex session cleanup temp file" >&2
    exit 1
  }
  find "$root" -mindepth 1 -print0 2>"$scan_error_file" |
    awk -v RS='\0' \
      -v budget="$scan_budget" \
      -v id="$id_lc" \
      -v id_no_dashes="$id_no_dashes_lc" \
      -v matches_file="$matching_entries_file" '
        function id_pattern_matches(name, key) {
          return name ~ key ".*\\.jsonl$" ||
            name ~ key ".*\\.jsonl\\.zst$" ||
            name ~ key ".*\\.jsonl\\.vm0tmp-" ||
            name ~ key ".*\\.jsonl\\.zst\\.vm0tmp-"
        }
        function filename_matches(path, name) {
          name = path
          sub(/^.*\//, "", name)
          name = tolower(name)
          return id_pattern_matches(name, id) ||
            id_pattern_matches(name, id_no_dashes)
        }
        NR > budget {
          exit 42
        }
        filename_matches($0) {
          printf "%s%c", $0, 0 >> matches_file
        }
      '
  scan_status=$?
  if [ "$scan_status" -eq 42 ]; then
    echo "codex session cleanup exceeded scan budget" >&2
    exit 1
  fi
  if [ "$scan_status" -ne 0 ]; then
    echo "cannot scan codex session directory" >&2
    exit 1
  fi
  if [ -s "$scan_error_file" ]; then
    echo "cannot scan codex session directory" >&2
    exit 1
  fi
}
delete_matching_session_entries() {
  if [ ! -s "$matching_entries_file" ]; then
    return
  fi
  xargs -0 sh -c '
    for path do
      if [ -f "$path" ] || [ -L "$path" ]; then
        rm -f -- "$path" || exit 1
      fi
    done
  ' sh < "$matching_entries_file" || {
    echo "failed to delete codex session files" >&2
    exit 1
  }
}
if [ -d "$root" ]; then
  scan_error_file=$(mktemp "${TMPDIR:-/tmp}/codex-session-cleanup.XXXXXX") || {
    echo "failed to create codex session cleanup temp file" >&2
    exit 1
  }
  matching_entries_file=$(mktemp "${TMPDIR:-/tmp}/codex-session-cleanup.XXXXXX") || {
    echo "failed to create codex session cleanup temp file" >&2
    exit 1
  }
  collect_matching_session_entries
  delete_matching_session_entries
fi
