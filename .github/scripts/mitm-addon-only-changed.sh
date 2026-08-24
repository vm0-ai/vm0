#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: mitm-addon-only-changed.sh <base-ref>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BASE_REF=$1

if ! BASE_COMMIT=$(git -C "$REPO_ROOT" rev-parse --verify "${BASE_REF}^{commit}" 2>/dev/null); then
  echo "Invalid base ref: ${BASE_REF}" >&2
  exit 2
fi

mapfile -d '' -t changed_files < <(
  git -C "$REPO_ROOT" diff --no-renames --name-only -z "$BASE_COMMIT" HEAD --
)

if [ "${#changed_files[@]}" -eq 0 ]; then
  echo "No changed files" >&2
  exit 1
fi

for changed_file in "${changed_files[@]}"; do
  case "$changed_file" in
    crates/runner/mitm-addon/*) ;;
    *)
      echo "Non-addon path changed: ${changed_file}" >&2
      exit 1
      ;;
  esac
done

echo "Only mitm-addon paths changed" >&2
