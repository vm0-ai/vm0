#!/bin/bash
# Coding Worker — deterministic decision script for the autonomous coding agent
# Usage:
#   scripts/coding-worker.sh <label>
#
# Output format:
#   First line: INTERVAL:<minutes>
#   Remaining lines: action prompt for the LLM (or "idle")
#
# The script queries GitHub state, makes all decisions, and outputs a prompt
# that /begin-coding-worker follows exactly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

LABEL="${1:?Usage: $0 <label>}"
STATE_FILE="/tmp/coding-worker-interval-${LABEL}"
CONTENT_DIR="/tmp/coding-worker"

mkdir -p "$CONTENT_DIR/issues" "$CONTENT_DIR/prs"

# --- Helper functions ---

output_action() {
  echo "1" > "$STATE_FILE"
  echo "INTERVAL:1"
}

output_idle() {
  local current=1
  if [ -f "$STATE_FILE" ]; then
    current=$(cat "$STATE_FILE")
  fi
  local next=$((current * 2))
  if [ "$next" -gt 30 ]; then
    next=30
  fi
  echo "$next" > "$STATE_FILE"
  echo "INTERVAL:${next}"
  echo "idle"
}

# Check if a GitHub user is trusted (@vm0.ai email or vm0-related login)
is_trusted_user() {
  local login="$1"
  # Trust vm0-bot and logins containing "vm0"
  if [[ "$login" == "vm0-bot" ]] || [[ "$login" == *"vm0"* ]]; then
    return 0
  fi
  # Check email
  local email
  email=$(gh api "users/${login}" --jq '.email // empty' 2>/dev/null || true)
  if [[ "$email" == *"@vm0.ai" ]]; then
    return 0
  fi
  return 1
}

# Download issue content with security filtering
# Writes to $CONTENT_DIR/issues/<number>.md
download_issue_content() {
  local number="$1"
  local outfile="$CONTENT_DIR/issues/${number}.md"

  # Get issue metadata
  local issue_json
  issue_json=$(gh issue view "$number" --repo "$REPO" --json title,body,author)
  local title author_login body
  title=$(echo "$issue_json" | jq -r '.title')
  author_login=$(echo "$issue_json" | jq -r '.author.login')
  body=$(echo "$issue_json" | jq -r '.body // empty')

  # Verify author is trusted
  if ! is_trusted_user "$author_login"; then
    echo "UNTRUSTED AUTHOR ($author_login) — skipped" > "$outfile"
    return 1
  fi

  # Write title and body
  {
    echo "# Issue #${number}: ${title}"
    echo ""
    echo "Author: ${author_login}"
    echo ""
    echo "## Description"
    echo ""
    echo "$body"
    echo ""
  } > "$outfile"

  # Get trusted comments
  local comments
  comments=$(gh api "repos/${REPO}/issues/${number}/comments" \
    --jq '[.[] | select(.user.login as $u | ($u == "vm0-bot" or ($u | test("vm0"))))] | .[] | "### Comment by \(.user.login)\n\n\(.body)\n"' 2>/dev/null || true)

  if [ -n "$comments" ]; then
    {
      echo "## Comments (trusted only)"
      echo ""
      echo "$comments"
    } >> "$outfile"
  fi

  return 0
}

# Download PR content with security filtering
# Writes to $CONTENT_DIR/prs/<number>.md
download_pr_content() {
  local number="$1"
  local outfile="$CONTENT_DIR/prs/${number}.md"

  # Get PR metadata
  local pr_json
  pr_json=$(gh pr view "$number" --repo "$REPO" --json title,body,author,headRefName)
  local title author_login body branch
  title=$(echo "$pr_json" | jq -r '.title')
  author_login=$(echo "$pr_json" | jq -r '.author.login')
  body=$(echo "$pr_json" | jq -r '.body // empty')
  branch=$(echo "$pr_json" | jq -r '.headRefName')

  # Write title and body
  {
    echo "# PR #${number}: ${title}"
    echo ""
    echo "Author: ${author_login}"
    echo "Branch: ${branch}"
    echo ""
    echo "## Description"
    echo ""
    echo "$body"
    echo ""
  } > "$outfile"

  # Get trusted issue comments
  local comments
  comments=$(gh api "repos/${REPO}/issues/${number}/comments" \
    --jq '[.[] | select(.user.login as $u | ($u == "vm0-bot" or ($u | test("vm0"))))] | .[] | "### Comment by \(.user.login)\n\n\(.body)\n"' 2>/dev/null || true)

  if [ -n "$comments" ]; then
    {
      echo "## Comments (trusted only)"
      echo ""
      echo "$comments"
    } >> "$outfile"
  fi

  # Get trusted PR review comments
  local review_comments
  review_comments=$(gh api "repos/${REPO}/pulls/${number}/comments" \
    --jq '[.[] | select(.user.login as $u | ($u == "vm0-bot" or ($u | test("vm0"))))] | .[] | "### Review by \(.user.login) on \(.path)\n\n\(.body)\n"' 2>/dev/null || true)

  if [ -n "$review_comments" ]; then
    {
      echo "## Review Comments (trusted only)"
      echo ""
      echo "$review_comments"
    } >> "$outfile"
  fi

  return 0
}

# --- Step 0: Sync main ---

rm -f .claude/scheduled_tasks.lock
git fetch origin main >&2 2>&1
git checkout -f main >&2 2>&1
git reset --hard origin/main >&2 2>&1
git clean -df >&2 2>&1
git stash clear >&2 2>&1

# --- Phase A: Check PRs ---

LANE_DATA=$("$SCRIPT_DIR/lane-status.sh" "$LABEL")
PRS=$(echo "$LANE_DATA" | jq '[.[0].prs // [] | .[] | select(.pending | not)]')
PR_COUNT=$(echo "$PRS" | jq 'length')

if [ "$PR_COUNT" -gt 0 ]; then
  PR_NUMBER=$(echo "$PRS" | jq -r '.[0].number')
  BRANCH=$(echo "$PRS" | jq -r '.[0].branch')

  PR_STATUS_JSON=$("$SCRIPT_DIR/pr-status.sh" "$PR_NUMBER")
  STATUS=$(echo "$PR_STATUS_JSON" | jq -r '.status')

  case "$STATUS" in
    conflict)
      output_action
      cat <<EOF
Spawn a subagent to resolve merge conflicts on PR #${PR_NUMBER} (branch: ${BRANCH}).

Steps:
1. gh pr merge --disable-auto ${PR_NUMBER}
2. git checkout ${BRANCH}
3. git fetch origin main && git merge origin/main
4. Resolve conflicts — typically additive, keep both sides, sort alphabetically
5. git add <resolved files> && git commit -m "chore: resolve merge conflict with main"
6. git push
7. git checkout main && git pull

Note: Do not merge in the same iteration after pushing. Wait for CI to pass in the next iteration.
EOF
      exit 0
      ;;

    ci_failing)
      FAILED_JOBS=$(echo "$PR_STATUS_JSON" | jq -r '.ci.failed_jobs | join(", ")')
      download_pr_content "$PR_NUMBER" || true
      output_action
      cat <<EOF
Spawn a subagent to fix CI failures on PR #${PR_NUMBER} (branch: ${BRANCH}).

Failed jobs: ${FAILED_JOBS}
PR details: ${CONTENT_DIR}/prs/${PR_NUMBER}.md

Rules:
- If runner/e2e failure: Use Slack MCP (slack_send_message, channelId: C0ALXC1SHHN) to post the failed job URL. Do not @ anyone.
- If flaky test (failure unrelated to PR changes): Report via Slack MCP to channelId C0ALXC1SHHN (include test name, failure message, job URL, PR number), then run gh run rerun <RUN_ID> --failed. Do not attempt to fix flaky tests.
- If lint/type/build failure: git checkout ${BRANCH}, fix the code, push.

When done: git checkout main && git pull
EOF
      exit 0
      ;;

    ci_running_no_review)
      # Delete old review comments directly
      echo "$PR_STATUS_JSON" | jq -r '.review.review_comment_ids[]' 2>/dev/null | \
        while read -r id; do
          gh api -X DELETE "repos/${REPO}/issues/comments/$id" 2>/dev/null || true
        done

      output_action
      cat <<EOF
Spawn a subagent: /pr-review ${PR_NUMBER}

After review:
- If P0/P1 issues found: git checkout ${BRANCH}, fix all P0/P1 issues, push, then git checkout main && git pull
- If no P0/P1 issues: run gh pr merge ${PR_NUMBER} --merge --auto, then git checkout main && git pull
EOF
      exit 0
      ;;

    ci_running_reviewed)
      # Nothing to do for this PR — fall through to Phase B
      ;;

    ci_passed)
      # Check if PR was recently ejected from the merge queue
      EJECTION=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/timeline" --paginate \
        --jq '[.[] | select(.event == "removed_from_merge_queue")] | last // empty' 2>/dev/null || true)

      if [ -n "$EJECTION" ]; then
        EJECTION_REASON=$(echo "$EJECTION" | jq -r '.reason // "unknown"')
        EJECTION_TIME=$(echo "$EJECTION" | jq -r '.created_at // "unknown"')
        output_action
        cat <<EOF
PR #${PR_NUMBER} (branch: ${BRANCH}) was ejected from the merge queue.

Ejection reason: ${EJECTION_REASON}
Ejection time: ${EJECTION_TIME}

Investigate the ejection before re-enqueueing:

1. If MERGE_CONFLICT: git checkout ${BRANCH} && git fetch origin main && git merge origin/main, resolve conflicts, push, then git checkout main && git pull
2. If CI_FAILURE: Check the merge queue build logs — gh run list --branch 'gh-readonly-queue/main/pr-${PR_NUMBER}-*' --status failure -L 1, then gh run view <run-id> --log-failed | tail -50. Fix real failures or rerun if flaky.
3. If DEQUEUED: Another PR in the group failed — safe to re-enqueue directly: gh pr merge ${PR_NUMBER} --repo ${REPO} --merge --auto
4. If unknown: Check PR timeline for details — gh api repos/${REPO}/pulls/${PR_NUMBER}/timeline --paginate | jq '[.[] | select(.event == "removed_from_merge_queue")]'

After resolving: git checkout main && git pull
EOF
        exit 0
      fi

      # No ejection — enable auto-merge directly, no subagent needed
      gh pr merge "$PR_NUMBER" --repo "$REPO" --merge --auto 2>/dev/null || true
      # Fall through to Phase B
      ;;
  esac
fi

# --- Phase B: Implement new issue ---

NEXT_ISSUE_JSON=$("$SCRIPT_DIR/next-issue.sh" "$LABEL" || true)

if [ -n "$NEXT_ISSUE_JSON" ]; then
  ISSUE_NUMBER=$(echo "$NEXT_ISSUE_JSON" | jq -r '.number')
  ISSUE_TITLE=$(echo "$NEXT_ISSUE_JSON" | jq -r '.title')
  IS_PENDING=$(echo "$NEXT_ISSUE_JSON" | jq -r '[.labels[] | select(. == "pending")] | length > 0')

  # Download and security-filter issue content
  if download_issue_content "$ISSUE_NUMBER"; then
    output_action

    if [ "$IS_PENDING" = "true" ]; then
      cat <<EOF
Spawn a subagent to review the plan completeness for issue #${ISSUE_NUMBER}.

Issue title: ${ISSUE_TITLE}
Issue content: ${CONTENT_DIR}/issues/${ISSUE_NUMBER}.md

Check whether issue #${ISSUE_NUMBER} has a complete plan:
- If the plan includes changes to **web**, the issue must list a test plan following /testing web guidelines.
- If the plan includes changes to **turbo/apps/app**, the issue must list a test plan following /testing platform guidelines.

If the test plan is incomplete or missing:
1. Add the missing test plan to the issue based on the relevant /testing skill.
2. When done: git checkout main && git pull

If the test plan is complete and the overall plan is solid with nothing requiring human confirmation:
1. Remove the pending label: gh issue edit ${ISSUE_NUMBER} --remove-label "pending"
2. When done: git checkout main && git pull
EOF
    else
      cat <<EOF
Spawn a subagent to work on issue #${ISSUE_NUMBER}.

Issue title: ${ISSUE_TITLE}
Issue content: ${CONTENT_DIR}/issues/${ISSUE_NUMBER}.md

Check if the issue already has a plan (a comment starting with "# Plan:").

If a plan exists:
1. Run /issue-action
2. After PR is created, add label: gh pr edit <PR_NUMBER> --add-label "${LABEL}"
3. When done: git checkout main && git pull

If no plan exists:
1. Run /issue-plan
2. When done: git checkout main && git pull
3. Do NOT run /issue-action in this iteration. Implementation will happen in the next iteration.
EOF
    fi
    exit 0
  fi
  # If download failed (untrusted author), fall through to idle
fi

# --- Nothing to do ---

output_idle
