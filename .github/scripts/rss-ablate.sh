#!/usr/bin/env bash
# Ablation harness for attributing the apps/api check-types peak-RSS regression
# introduced by feeb1cbc (#25489). Reverts one slice of that commit back to its
# parent bfaefe76 and lets tsc run; type errors are expected and irrelevant --
# only peak RSS is being measured.
set -euo pipefail

PARENT=bfaefe761de60bc39e8ea773487a342468c12a77
variant="${1:?variant required}"

revert() {
  local pathspec
  for pathspec in "$@"; do
    git diff --name-only "$PARENT" HEAD -- "$pathspec" | while IFS= read -r f; do
      [ -n "$f" ] || continue
      if git cat-file -e "$PARENT:$f" 2>/dev/null; then
        git checkout "$PARENT" -- "$f"
      else
        rm -f "$f"
      fi
    done
  done
}

API=turbo/apps/api/src
CONTRACTS=turbo/packages/api-contracts/src/contracts

case "$variant" in
  head)
    : # unmodified feeb1cbc
    ;;
  parent)
    revert turbo/
    ;;
  no-contracts)
    revert turbo/packages/api-contracts/ turbo/packages/core/
    ;;
  no-services)
    revert "$API/signals/services/"
    ;;
  no-routes)
    revert "$API/signals/routes/runners.ts" \
      "$API/signals/routes/webhooks-agent-pi-transcript.ts" \
      "$API/signals/route.ts" \
      "$API/signals/external/realtime.ts" \
      "$API/lib/tar.ts"
    ;;
  no-tests)
    revert "$API/signals/routes/__tests__/"
    ;;
  stub-pi-runtime)
    # Keep every api-side change, but collapse the new @vm0/pi-agent-runtime
    # package (and therefore @earendil-works/pi-agent-core + pi-ai) out of the
    # type graph.
    printf 'export {};\n' >turbo/packages/pi-agent-runtime/src/index.ts
    printf 'export {};\n' >turbo/packages/pi-agent-runtime/src/node.ts
    ;;
  no-contract-runners)
    revert "$CONTRACTS/runners.ts"
    ;;
  no-contract-webhooks)
    revert "$CONTRACTS/webhooks.ts" \
      "$CONTRACTS/model-provider-firewalls.ts" \
      "$CONTRACTS/model-providers.ts"
    ;;
  *)
    echo "unknown variant: $variant" >&2
    exit 1
    ;;
esac

echo "--- ablation [$variant] working tree delta:"
git status --short
