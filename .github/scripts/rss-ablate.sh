#!/usr/bin/env bash
# A/B harness for the apps/api check-types peak-RSS work. `base` restores every
# turbo/ file to the branch point so both variants are measured in one run.
set -euo pipefail

BASE=0c35f8f533d8f85a3a16a9bc6751bef5d2b1a9ea
variant="${1:?variant required}"

case "$variant" in
  head) : ;;
  base)
    git diff --name-only "$BASE" HEAD -- turbo/ | while IFS= read -r f; do
      [ -n "$f" ] || continue
      if git cat-file -e "$BASE:$f" 2>/dev/null; then
        git checkout "$BASE" -- "$f"
      else
        rm -f "$f"
      fi
    done
    ;;
  *)
    echo "unknown variant: $variant" >&2
    exit 1
    ;;
esac

echo "--- ablation [$variant] working tree delta:"
git status --short
