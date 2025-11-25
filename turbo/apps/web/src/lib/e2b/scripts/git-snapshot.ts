/**
 * Git snapshot script for creating checkpoint snapshots
 * Creates a branch, commits changes, and pushes to remote
 */
export const GIT_SNAPSHOT_SCRIPT = `# Create Git snapshot for a volume
# Requires: COMMON_SCRIPT to be sourced first (for RUN_ID)

create_git_snapshot() {
  local mount_path="$1"
  local volume_name="$2"
  local branch_name="run-$RUN_ID"

  # Change to volume directory
  cd "$mount_path" || {
    echo "[ERROR] Failed to cd to $mount_path" >&2
    return 1
  }

  # Configure Git user
  git config user.name "VM0 Agent" 2>/dev/null || true
  git config user.email "agent@vm0.ai" 2>/dev/null || true

  # Create and switch to new branch
  if ! git checkout -b "$branch_name" 2>/dev/null; then
    echo "[ERROR] Failed to create branch $branch_name" >&2
    return 1
  fi

  # Stage all changes
  git add -A 2>/dev/null || true

  # Check if there are changes to commit
  if git diff --cached --quiet 2>/dev/null; then
    echo "[VM0] No changes to commit in volume '$volume_name'" >&2
    # Push the branch even without new commits so resume can find it
    if ! git push origin "$branch_name" >/dev/null 2>&1; then
      echo "[ERROR] Failed to push branch $branch_name" >&2
      return 1
    fi
    # Return current commit
    COMMIT_ID=$(git rev-parse HEAD 2>/dev/null || echo "")
    if [ -n "$COMMIT_ID" ]; then
      # Use jq to generate valid JSON
      jq -n --arg branch "$branch_name" --arg commit "$COMMIT_ID" '{branch: $branch, commitId: $commit}'
      return 0
    else
      return 1
    fi
  fi

  # Commit changes (suppress stdout and stderr)
  local commit_message="checkpoint: save state for run $RUN_ID"
  if ! git commit -m "$commit_message" >/dev/null 2>&1; then
    echo "[ERROR] Failed to commit changes" >&2
    return 1
  fi

  # Push to remote (suppress stdout and stderr)
  if ! git push origin "$branch_name" >/dev/null 2>&1; then
    echo "[ERROR] Failed to push branch $branch_name" >&2
    return 1
  fi

  # Get commit ID
  COMMIT_ID=$(git rev-parse HEAD 2>/dev/null || echo "")
  if [ -z "$COMMIT_ID" ]; then
    echo "[ERROR] Failed to get commit ID" >&2
    return 1
  fi

  # Use jq to generate valid JSON
  jq -n --arg branch "$branch_name" --arg commit "$COMMIT_ID" '{branch: $branch, commitId: $commit}'
  return 0
}
`;
