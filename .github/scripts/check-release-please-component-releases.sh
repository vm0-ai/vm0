#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "release presence check: $1" >&2
  exit 1
}

if [ "$#" -ne 3 ]; then
  fail "usage: check-release-please-component-releases.sh <merge-group-base> <merge-group-head> <release-pr-head>"
fi

merge_group_base=$1
merge_group_head=$2
release_pr_head=$3

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) ||
  fail "current directory is not inside a Git repository"
cd "$repo_root"

resolve_commit() {
  local revision=$1 label=$2
  git rev-parse --verify "${revision}^{commit}" 2>/dev/null ||
    fail "${label} is not an available commit: ${revision}"
}

merge_group_base=$(resolve_commit "$merge_group_base" "merge-group base")
merge_group_head=$(resolve_commit "$merge_group_head" "merge-group head")
release_pr_head=$(resolve_commit "$release_pr_head" "release PR head")

mapfile -t merge_group_commit < <(
  git rev-list --parents --max-count=1 "$merge_group_head"
)
read -r -a merge_group_commit <<<"${merge_group_commit[0]}"
if [ "${#merge_group_commit[@]}" -ne 2 ]; then
  fail "merge-group head must have exactly one parent"
fi
if [ "${merge_group_commit[1]}" != "$merge_group_base" ]; then
  fail "merge-group base is not the direct parent of merge-group head"
fi

mapfile -t release_commit < <(
  git rev-list --parents --max-count=1 "$release_pr_head"
)
read -r -a release_commit <<<"${release_commit[0]}"
if [ "${#release_commit[@]}" -ne 2 ]; then
  fail "release PR head must have exactly one parent"
fi
generation_base=${release_commit[1]}

git merge-base --is-ancestor "$generation_base" "$merge_group_base" ||
  fail "release PR generation base is not an ancestor of merge-group base"

read_git_json() {
  local revision=$1 path=$2 label=$3
  local content

  content=$(git show "${revision}:${path}" 2>/dev/null) ||
    fail "missing ${label} at ${revision}: ${path}"
  jq -ceS . <<<"$content" 2>/dev/null ||
    fail "invalid ${label} at ${revision}: ${path}"
}

release_config=$(
  read_git_json \
    "$merge_group_base" \
    "release-please-config.json" \
    "Release Please config"
)
generation_manifest=$(
  read_git_json \
    "$generation_base" \
    ".release-please-manifest.json" \
    "generation manifest"
)
release_manifest=$(
  read_git_json \
    "$release_pr_head" \
    ".release-please-manifest.json" \
    "release PR manifest"
)
merge_group_manifest=$(
  read_git_json \
    "$merge_group_head" \
    ".release-please-manifest.json" \
    "merge-group manifest"
)

if [ "$release_manifest" != "$merge_group_manifest" ]; then
  fail "release PR manifest does not match merge-group head"
fi

components_json=$(jq -ce '
  .packages
  | select(type == "object")
  | keys
  | select(length > 0)
' <<<"$release_config" 2>/dev/null) ||
  fail "Release Please config must contain a non-empty packages object"
mapfile -t components < <(jq -r '.[]' <<<"$components_json")

missing_releases=()
for component in "${components[@]}"; do
  if [[ ! "$component" =~ ^[A-Za-z0-9._/-]+$ ]] ||
    [[ "$component" == /* || "$component" == */ ||
      "/$component/" == *"/../"* || "/$component/" == *"/./"* ||
      "/$component/" == *"//"* ]]; then
    fail "unsafe component path in Release Please config: ${component}"
  fi

  pathspec=":(top,glob)${component}/**/src/**"
  if git diff --quiet "$generation_base" "$merge_group_base" -- "$pathspec"; then
    continue
  else
    diff_status=$?
    if [ "$diff_status" -ne 1 ]; then
      fail "could not compare source changes for ${component}"
    fi
  fi

  generation_version=$(jq -er --arg component "$component" '
    .[$component]
    | select(type == "string" and length > 0)
  ' <<<"$generation_manifest" 2>/dev/null) ||
    fail "generation manifest is missing a version for ${component}"
  release_version=$(jq -er --arg component "$component" '
    .[$component]
    | select(type == "string" and length > 0)
  ' <<<"$release_manifest" 2>/dev/null) ||
    fail "release PR manifest is missing a version for ${component}"

  if [ "$generation_version" = "$release_version" ]; then
    missing_releases+=("$component")
  else
    echo "release presence check: ${component} source changed and release advances ${generation_version} -> ${release_version}"
  fi
done

if [ "${#missing_releases[@]}" -ne 0 ]; then
  for component in "${missing_releases[@]}"; do
    echo "::error title=Missing component release::${component} has intervening source changes but no new release" >&2
  done
  fail "${#missing_releases[@]} component release(s) missing"
fi

echo "release presence check: all intervening component source changes have releases"
