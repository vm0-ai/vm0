#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
CONTEXT_PATH=".github/scripts/runner-binary-build/context.json"

declare CONTEXT_JSON=""
declare -a SELECTED_PATHS=()
declare -a STRUCTURAL_PATHS=()
declare -A STRUCTURAL_ENTRY_PATHS=()

fail() {
  echo "runner binary context: $1" >&2
  exit 1
}

load_context_json() {
  local context_json=$1

  if ! jq -e '
    def package_fields:
      (.name | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_-]*$")) and
      (.path | type == "string" and
        test("^crates/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$"));
    def package:
      type == "object" and
      keys == ["name", "path"] and
      package_fields;
    def structural_package:
      type == "object" and
      keys == ["name", "path", "targetEntries"] and
      package_fields and
      (.targetEntries |
        type == "array" and length > 0 and
        all(.[];
          type == "string" and
          test("^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$")) and
        . == (sort | unique));
    type == "object" and
    keys == ["selectedPackages", "structuralPackages"] and
    (.selectedPackages |
      type == "array" and length > 0 and all(.[]; package) and
      . == (sort_by(.name))) and
    (.structuralPackages |
      type == "array" and length > 0 and all(.[]; structural_package) and
      . == (sort_by(.name))) and
    ([.selectedPackages[].name, .structuralPackages[].name] |
      length == (unique | length)) and
    ([.selectedPackages[].path, .structuralPackages[].path] |
      length == (unique | length))
  ' <<<"$context_json" >/dev/null; then
    fail "invalid context declaration"
  fi

  CONTEXT_JSON=$context_json
  mapfile -t SELECTED_PATHS < <(jq -r '.selectedPackages[].path' <<<"$CONTEXT_JSON")
  mapfile -t STRUCTURAL_PATHS < <(jq -r '.structuralPackages[].path' <<<"$CONTEXT_JSON")
  STRUCTURAL_ENTRY_PATHS=()
  while IFS=$'\t' read -r package_path target_entry; do
    STRUCTURAL_ENTRY_PATHS["${package_path}/${target_entry}"]=1
  done < <(
    jq -r '
      .structuralPackages[] |
      .path as $path |
      .targetEntries[] |
      [$path, .] |
      @tsv
    ' <<<"$CONTEXT_JSON"
  )
}

load_revision_context() {
  local repo_root=$1 revision=$2 context_json
  if ! context_json=$(git -C "$repo_root" show "${revision}:${CONTEXT_PATH}"); then
    fail "cannot read ${CONTEXT_PATH} at ${revision}"
  fi
  load_context_json "$context_json"
}

is_safe_git_path() {
  local path=$1
  [[ -n "$path" && "$path" != /* && "$path" != */ ]] || return 1
  case "/${path}/" in
    *"//"*|*"/./"*|*"/../"*) return 1 ;;
  esac
}

is_included_path() {
  local path=$1 package_path relative

  case "$path" in
    .github/scripts/runner-binary-build/*|crates/.cargo/*)
      return 0
      ;;
    crates/Cargo.lock|crates/Cargo.toml)
      return 0
      ;;
  esac

  for package_path in "${SELECTED_PATHS[@]}"; do
    if [[ "$path" == "${package_path}/"* ]]; then
      relative=${path#"${package_path}/"}
      case "$relative" in
        tests/*|benches/*|examples/*)
          return 1
          ;;
      esac
      if [[ "$package_path" == "crates/runner" && "$relative" == mitm-addon/tests/* ]]; then
        return 1
      fi
      return 0
    fi
  done

  for package_path in "${STRUCTURAL_PATHS[@]}"; do
    if [[ "$path" == "${package_path}/Cargo.toml" ]]; then
      return 0
    fi
  done
  [[ ${STRUCTURAL_ENTRY_PATHS[$path]+present} ]]
}

emit_inventory() {
  local repo_root=$1 revision=$2 record metadata path mode type object extra
  local package_path required_path
  local -a tree_entries=()
  local -a required_paths=(
    "$CONTEXT_PATH"
    ".github/scripts/runner-binary-build/build.sh"
    ".github/scripts/runner-binary-build/compile.sh"
    ".github/scripts/runner-binary-build/context.sh"
    ".github/scripts/runner-binary-build/contract.env"
    ".github/scripts/runner-binary-build/digest.sh"
    "crates/Cargo.lock"
    "crates/Cargo.toml"
  )
  local -A found_paths=()

  git -C "$repo_root" rev-parse --verify "${revision}^{commit}" >/dev/null ||
    fail "invalid committed revision: ${revision}"
  load_revision_context "$repo_root" "$revision"

  for package_path in "${SELECTED_PATHS[@]}" "${STRUCTURAL_PATHS[@]}"; do
    required_paths+=("${package_path}/Cargo.toml")
  done
  for required_path in "${!STRUCTURAL_ENTRY_PATHS[@]}"; do
    required_paths+=("$required_path")
  done

  mapfile -d '' -t tree_entries < <(
    git -C "$repo_root" ls-tree --full-tree -r -z "$revision" -- \
      .github/scripts/runner-binary-build \
      crates
  )
  for record in "${tree_entries[@]}"; do
    [[ "$record" == *$'\t'* ]] || fail "malformed Git tree entry"
    metadata=${record%%$'\t'*}
    path=${record#*$'\t'}
    extra=""
    IFS=' ' read -r mode type object extra <<<"$metadata"
    [[ -z "$extra" && -n "$mode" && -n "$type" && -n "$object" ]] ||
      fail "malformed Git tree metadata for ${path}"

    if ! is_included_path "$path"; then
      continue
    fi
    is_safe_git_path "$path" || fail "unsafe included path: ${path}"
    [[ "$type" == "blob" ]] || fail "unsupported included Git object ${type}: ${path}"
    case "$mode" in
      100644|100755) ;;
      *) fail "unsupported included Git mode ${mode}: ${path}" ;;
    esac

    found_paths["$path"]=1
    printf '%s\0' "$record"
  done

  for required_path in "${required_paths[@]}"; do
    [[ ${found_paths[$required_path]+present} ]] ||
      fail "required context path is not a tracked regular file: ${required_path}"
  done
}

validate_workspace() {
  local source_root=$1 crates_dir context_file inventory metadata
  local package_path target_entry

  crates_dir="${source_root}/crates"
  context_file="${source_root}/${CONTEXT_PATH}"
  inventory="${crates_dir}/runner/guest-binaries.json"
  [[ -f "$context_file" ]] || fail "missing context declaration: ${context_file}"
  [[ -f "$inventory" ]] || fail "missing guest inventory: ${inventory}"
  load_context_json "$(<"$context_file")"

  for package_path in "${SELECTED_PATHS[@]}" "${STRUCTURAL_PATHS[@]}"; do
    [[ -f "${source_root}/${package_path}/Cargo.toml" ]] ||
      fail "missing declared package manifest: ${package_path}/Cargo.toml"
  done
  while IFS= read -r target_entry; do
    [[ -f "${source_root}/${target_entry}" ]] ||
      fail "missing structural target entry: ${target_entry}"
  done < <(printf '%s\n' "${!STRUCTURAL_ENTRY_PATHS[@]}" | sort)

  if ! metadata=$(
    cd "$crates_dir"
    cargo metadata --locked --no-deps --format-version 1
  ); then
    fail "Cargo cannot load the materialized workspace"
  fi

  if ! jq -e \
    --argjson context "$CONTEXT_JSON" \
    --slurpfile guests "$inventory" '
      def closure($edges; $pending; $seen):
        ($pending | unique |
          map(. as $name | select(($seen | index($name)) == null))) as $new |
        if ($new | length) == 0 then
          ($seen | unique | sort)
        else
          ([ $new[] as $name | ($edges[$name] // [])[] ]) as $next |
          closure($edges; $next; ($seen + $new))
        end;

      . as $metadata |
      ($metadata.workspace_root + "/") as $workspace_prefix |
      ($metadata.packages | map(
        select(
          (.manifest_path | startswith($workspace_prefix)) and
          (.manifest_path | endswith("/Cargo.toml"))
        ) |
        {
          name,
          path: (
            "crates/" +
            (.manifest_path |
              ltrimstr($workspace_prefix) |
              rtrimstr("/Cargo.toml"))
          )
        }
      ) | sort_by(.name)) as $actual_packages |
      ($context.selectedPackages + $context.structuralPackages |
        map({name, path}) |
        sort_by(.name)) as $declared_packages |
      ($metadata.packages | map({
        key: .name,
        value: [
          .dependencies[] |
          select(.path != null and .kind != "dev") |
          .name
        ]
      }) | from_entries) as $edges |
      (["runner"] + [$guests[0][].package] | unique) as $roots |
      closure($edges; $roots; []) as $selected |
      ($context.selectedPackages | map(.name) | sort) as $declared_selected |
      ($context.structuralPackages | map(.name) | sort) as $declared_structural |
      ($actual_packages | map(.name) | sort) as $actual_names |

      ($actual_packages == $declared_packages) and
      ($selected == $declared_selected) and
      (($actual_names - $selected) == $declared_structural) and
      all($roots[]; . as $root | ($actual_names | index($root)) != null)
    ' <<<"$metadata" >/dev/null; then
    fail "context declaration does not match the local non-dev Cargo closure"
  fi
}

case "${1:-}" in
  inventory)
    repo_root="${2:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)}"
    emit_inventory "$repo_root" "${3:-HEAD}"
    ;;
  validate-workspace)
    validate_workspace "${2:-$SOURCE_ROOT}"
    ;;
  *)
    echo "usage: context.sh inventory [repo-root] [revision] | validate-workspace [source-root]" >&2
    exit 2
    ;;
esac
