mode="$VM0_CODEX_RESTORE_MODE"
case "$mode" in
  prepare|commit) ;;
  *)
    echo "invalid codex restore mode" >&2
    exit 1
    ;;
esac

root="$codex_home/sessions"
restore_path="$VM0_CODEX_RESTORE_SESSION_PATH"
staging_path="$VM0_CODEX_RESTORE_STAGING_PATH"
restore_dir="${restore_path%/*}"
staging_dir="${staging_path%/*}"

root_prefix="$root/"
case "$restore_dir" in
  "$root/"*) ;;
  *)
    echo "invalid codex restore directory" >&2
    exit 1
    ;;
esac
relative_dir="${restore_dir#"$root_prefix"}"
case "$relative_dir" in
  */*/*) ;;
  *)
    echo "invalid codex restore directory" >&2
    exit 1
    ;;
esac
last_component="${relative_dir##*/}"
parent_components="${relative_dir%/*}"
case "$last_component" in
  ""|*/*)
    echo "invalid codex restore directory" >&2
    exit 1
    ;;
esac
case "$parent_components" in
  */*) ;;
  *)
    echo "invalid codex restore directory" >&2
    exit 1
    ;;
esac
first_component="${parent_components%%/*}"
second_component="${parent_components#*/}"
case "$first_component:$second_component" in
  *:*/*|:*|*:)
    echo "invalid codex restore directory" >&2
    exit 1
    ;;
esac
if [ "$staging_dir" != "$restore_dir" ]; then
  echo "invalid codex restore staging directory" >&2
  exit 1
fi
case "$staging_path" in
  "$restore_path".vm0tmp-?*) ;;
  *)
    echo "invalid codex restore staging path" >&2
    exit 1
    ;;
esac

check_restore_dir_component() {
  path="$1"
  if [ -L "$path" ]; then
    echo "codex restore directory is a symlink" >&2
    exit 1
  fi
  if [ -e "$path" ] && [ ! -d "$path" ]; then
    echo "codex restore path component is not a directory" >&2
    exit 1
  fi
}

ensure_restore_dir_component() {
  path="$1"
  check_restore_dir_component "$path"
  if [ ! -d "$path" ]; then
    mkdir -- "$path" || {
      echo "failed to create codex restore directory" >&2
      exit 1
    }
  fi
  check_restore_dir_component "$path"
}

if [ "$mode" = "prepare" ]; then
  ensure_restore_dir_component "$codex_home"
  ensure_restore_dir_component "$root"
else
  check_restore_dir_component "$codex_home"
  check_restore_dir_component "$root"
  if [ ! -d "$root" ]; then
    echo "codex restore directory is missing" >&2
    exit 1
  fi
fi

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
      echo "invalid codex restore path component" >&2
      exit 1
      ;;
  esac
  current="$current/$component"
  if [ "$mode" = "prepare" ]; then
    ensure_restore_dir_component "$current"
  else
    check_restore_dir_component "$current"
    if [ ! -d "$current" ]; then
      echo "codex restore directory is missing" >&2
      exit 1
    fi
  fi
done

if [ -L "$restore_path" ]; then
  echo "codex restore target is a symlink" >&2
  exit 1
fi
if [ -e "$restore_path" ] && [ ! -f "$restore_path" ]; then
  echo "codex restore target is not a regular file" >&2
  exit 1
fi

if [ "$mode" = "prepare" ]; then
  if [ -e "$staging_path" ] || [ -L "$staging_path" ]; then
    echo "codex restore staging path already exists" >&2
    exit 1
  fi
  exit 0
fi

if [ -L "$staging_path" ]; then
  echo "codex restore staging path is a symlink" >&2
  exit 1
fi
if [ ! -f "$staging_path" ]; then
  echo "codex restore staging path is not a regular file" >&2
  exit 1
fi

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

# Codex resume can see matching session files anywhere below sessions. The
# explicit entry budget keeps duplicate cleanup bounded. The current target and
# complete staging file remain recoverable until the final atomic rename.
scan_error_file=""
matching_entries_file=""
cleanup_scan_temp_files() {
  if [ -n "$scan_error_file" ]; then
    rm -f -- "$scan_error_file"
  fi
  if [ -n "$matching_entries_file" ]; then
    rm -f -- "$matching_entries_file"
  fi
}
cleanup_scan_temp_files_and_exit() {
  cleanup_scan_temp_files
  exit 1
}
trap cleanup_scan_temp_files EXIT
trap cleanup_scan_temp_files_and_exit HUP INT TERM

scan_error_file=$(mktemp "${TMPDIR:-/tmp}/codex-session-cleanup.XXXXXX") || {
  echo "failed to create codex session cleanup temp file" >&2
  exit 1
}
matching_entries_file=$(mktemp "${TMPDIR:-/tmp}/codex-session-cleanup.XXXXXX") || {
  echo "failed to create codex session cleanup temp file" >&2
  exit 1
}

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
    -v restore_path="$restore_path" \
    -v staging_path="$staging_path" \
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
      filename_matches($0) && $0 != restore_path && $0 != staging_path {
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

if [ -s "$matching_entries_file" ]; then
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
fi

if ! mv -fT -- "$staging_path" "$restore_path"; then
  echo "failed to commit codex session history" >&2
  exit 1
fi
