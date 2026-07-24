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
relative_dir="${restore_dir#"$root_prefix"}"
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
candidate_path_file=""
cleanup_temp_files() {
  if [ -n "$scan_error_file" ]; then
    rm -f -- "$scan_error_file"
  fi
  if [ -n "$matching_entries_file" ]; then
    rm -f -- "$matching_entries_file"
  fi
  if [ -n "$candidate_path_file" ]; then
    rm -f -- "$candidate_path_file"
  fi
}
cleanup_temp_files_and_exit() {
  cleanup_temp_files
  exit 1
}
trap cleanup_temp_files EXIT
trap cleanup_temp_files_and_exit HUP INT TERM
collect_matching_session_entries() {
  : > "$scan_error_file" || {
    echo "failed to reset codex session cleanup temp file" >&2
    exit 1
  }
  : > "$matching_entries_file" || {
    echo "failed to reset codex session cleanup temp file" >&2
    exit 1
  }
  : > "$candidate_path_file" || {
    echo "failed to reset codex session cleanup temp file" >&2
    exit 1
  }
  find "$root" -mindepth 1 -printf '%y%p\0' 2>"$scan_error_file" |
    awk -v RS='\0' \
      -v budget="$scan_budget" \
      -v id="$id_lc" \
      -v id_no_dashes="$id_no_dashes_lc" \
      -v root="$root" \
      -v candidate_file="$candidate_path_file" \
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
        function numeric_component(value, expected_length) {
          return length(value) == expected_length &&
            value ~ /^[0123456789]+$/
        }
        function valid_calendar_date(year, month, day, year_number, month_number, day_number, leap_year, max_day) {
          year_number = year + 0
          month_number = month + 0
          day_number = day + 0
          if (year_number < 1 || month_number < 1 || month_number > 12) {
            return 0
          }
          if (month_number == 2) {
            leap_year = year_number % 4 == 0 &&
              (year_number % 100 != 0 || year_number % 400 == 0)
            max_day = 28 + leap_year
          } else if (month_number == 4 ||
                     month_number == 6 ||
                     month_number == 9 ||
                     month_number == 11) {
            max_day = 30
          } else {
            max_day = 31
          }
          return day_number >= 1 && day_number <= max_day
        }
        function canonical_logical_path(path, entry_type, relative, component_count, components, year, month, day, filename, prefix, tail, time, suffix, hour, minute, second, logical_filename) {
          if (entry_type != "f" || index(path, root "/") != 1) {
            return ""
          }
          relative = substr(path, length(root) + 2)
          component_count = split(relative, components, "/")
          if (component_count != 4) {
            return ""
          }
          year = components[1]
          month = components[2]
          day = components[3]
          filename = components[4]
          if (!numeric_component(year, 4) ||
              !numeric_component(month, 2) ||
              !numeric_component(day, 2) ||
              !valid_calendar_date(year, month, day)) {
            return ""
          }
          prefix = "rollout-" year "-" month "-" day "T"
          if (substr(filename, 1, length(prefix)) != prefix) {
            return ""
          }
          tail = substr(filename, length(prefix) + 1)
          time = substr(tail, 1, 8)
          suffix = substr(tail, 9)
          if (time !~ /^[0123456789][0123456789]-[0123456789][0123456789]-[0123456789][0123456789]$/ ||
              (suffix != "-" id ".jsonl" &&
               suffix != "-" id ".jsonl.zst")) {
            return ""
          }
          hour = substr(time, 1, 2) + 0
          minute = substr(time, 4, 2) + 0
          second = substr(time, 7, 2) + 0
          if (hour > 23 || minute > 59 || second > 59) {
            return ""
          }
          logical_filename = filename
          sub(/\.zst$/, "", logical_filename)
          return root "/" year "/" month "/" day "/" logical_filename
        }
        NR > budget {
          scan_status = 42
          exit
        }
        {
          entry_type = substr($0, 1, 1)
          path = substr($0, 2)
        }
        filename_matches(path) {
          printf "%s%c", path, 0 >> matches_file
          logical_path = canonical_logical_path(path, entry_type)
          if (logical_path != "") {
            if (candidate_path == "") {
              candidate_path = logical_path
            } else if (candidate_path != logical_path) {
              candidate_ambiguous = 1
            }
          }
        }
        END {
          if (scan_status != 0) {
            exit scan_status
          }
          if (candidate_ambiguous) {
            exit 43
          }
          if (candidate_path != "") {
            print candidate_path > candidate_file
          }
        }
      '
  scan_status=$?
  if [ "$scan_status" -eq 42 ]; then
    echo "codex session cleanup exceeded scan budget" >&2
    exit 1
  fi
  if [ "$scan_status" -eq 43 ]; then
    echo "ambiguous codex session restore path" >&2
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
        rm -f -- "$path" 2>/dev/null || exit 1
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
  candidate_path_file=$(mktemp "${TMPDIR:-/tmp}/codex-session-cleanup.XXXXXX") || {
    echo "failed to create codex session cleanup temp file" >&2
    exit 1
  }
  collect_matching_session_entries
  delete_matching_session_entries
  if [ -s "$candidate_path_file" ]; then
    IFS= read -r candidate_path < "$candidate_path_file" || {
      echo "failed to read codex session restore path" >&2
      exit 1
    }
    printf '%s\n' "$candidate_path"
  fi
fi
