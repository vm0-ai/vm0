#!/bin/bash
# Check which turbo packages need to be rebuilt by comparing task hashes
# Usage: changed.sh [base-ref]
# Output: JSON object with package names as keys and boolean values (true = changed)
# Example output: {"@vm0/cli": true, "@vm0/web": false}

set -e

BASE_REF=${1:-HEAD^}

echo "Comparing current HEAD against $BASE_REF..." >&2

# Helper function to extract all task hashes from turbo output
extract_all_hashes() {
  local file=$1
  # Find the line with opening brace, then parse JSON from there
  grep -n "^{" "$file" | head -1 | cut -d: -f1 | xargs -I {} tail -n +{} "$file" | \
    jq -r '.tasks[] | select(.task == "build") | {taskId: .taskId, hash: .hash}' 2>/dev/null | \
    jq -s 'map({(.taskId | split("#")[0]): .hash}) | add' 2>/dev/null || echo "{}"
}

# Get current commit hash
CURRENT_COMMIT=$(git rev-parse HEAD)
BASE_COMMIT=$(git rev-parse "$BASE_REF")

echo "Current commit: $CURRENT_COMMIT" >&2
echo "Base commit:    $BASE_COMMIT" >&2

# Get task hashes for current commit
cd turbo
echo "Calculating hashes for current commit..." >&2
npx -y turbo@^2.5.6 run build --dry=json > /tmp/turbo-current.json 2>&1
CURRENT_HASHES=$(extract_all_hashes /tmp/turbo-current.json)

if [ "$CURRENT_HASHES" = "{}" ]; then
  echo "Error: Could not extract current hashes" >&2
  exit 2
fi

echo "Current hashes:" >&2
echo "$CURRENT_HASHES" | jq '.' >&2

# Create a temporary worktree for base commit
WORKTREE_DIR=$(mktemp -d)
trap "rm -rf $WORKTREE_DIR" EXIT

echo "Creating worktree for base commit..." >&2
git worktree add --detach "$WORKTREE_DIR" "$BASE_COMMIT" >/dev/null 2>&1

# Get task hashes for base commit
cd "$WORKTREE_DIR/turbo"
echo "Calculating hashes for base commit..." >&2
npx -y turbo@^2.5.6 run build --dry=json > /tmp/turbo-base.json 2>&1
BASE_HASHES=$(extract_all_hashes /tmp/turbo-base.json)

if [ "$BASE_HASHES" = "{}" ]; then
  echo "Error: Could not extract base hashes" >&2
  exit 2
fi

echo "Base hashes:" >&2
echo "$BASE_HASHES" | jq '.' >&2

# Cleanup worktree
cd - >/dev/null
git worktree remove "$WORKTREE_DIR" --force >/dev/null 2>&1

# Compare hashes and generate output
echo "Comparing hashes..." >&2
RESULT=$(jq -n \
  --argjson current "$CURRENT_HASHES" \
  --argjson base "$BASE_HASHES" \
  '$current | to_entries | map({
    key: .key,
    value: (.value != $base[.key])
  }) | from_entries')

echo "Changes detected:" >&2
echo "$RESULT" | jq '.' >&2

# Output the result to stdout (without extra logging)
echo "$RESULT"
