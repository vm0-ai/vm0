#!/bin/bash
# Coding Loop Driver — deterministic decision script for the autonomous coding agent
# Usage:
#   scripts/coding-loop.sh <label>
#
# Output format:
#   First line: INTERVAL:<minutes>
#   Remaining lines: action prompt for the LLM (or "idle")
#
# The script queries GitHub state, makes all decisions, and outputs a prompt
# that /begin-coding-loop follows exactly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

LABEL="${1:?Usage: $0 <label>}"
STATE_FILE="/tmp/coding-loop-interval-${LABEL}"
CONTENT_DIR="/tmp/coding-loop"

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
开一个 subagent，解决 PR #${PR_NUMBER} (branch: ${BRANCH}) 的合并冲突。

操作步骤：
1. gh pr merge --disable-auto ${PR_NUMBER}
2. git checkout ${BRANCH}
3. git fetch origin main && git merge origin/main
4. 解决冲突 — 通常是 additive 的，保留双方内容，按字母序排列
5. git add <resolved files> && git commit -m "chore: resolve merge conflict with main"
6. git push
7. git checkout main && git pull

注意：推完后不要在同一轮 merge，等下一轮 CI 跑完再处理。
EOF
      exit 0
      ;;

    ci_failing)
      FAILED_JOBS=$(echo "$PR_STATUS_JSON" | jq -r '.ci.failed_jobs | join(", ")')
      download_pr_content "$PR_NUMBER" || true
      output_action
      cat <<EOF
开一个 subagent，解决 PR #${PR_NUMBER} (branch: ${BRANCH}) 的 CI 失败问题。

失败的 jobs: ${FAILED_JOBS}
PR 详情见: ${CONTENT_DIR}/prs/${PR_NUMBER}.md

处理规则：
- 如果是 runner/e2e 失败：用 Slack MCP (slack_send_message, channelId: C0ALXC1SHHN) 发消息，附上失败 job URL。不要 @ 任何人。
- 如果是 flaky test（和 PR 改动无关的测试失败）：用 Slack MCP 报告到 channelId C0ALXC1SHHN（附 test name, failure message, job URL, PR number），然后执行 gh run rerun <RUN_ID> --failed。不要尝试修复 flaky test。
- 如果是 lint/type/build 失败：git checkout ${BRANCH}，修复代码，push。

完成后回到 main: git checkout main && git pull
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
开一个 subagent，/pr-review ${PR_NUMBER}

审查完成后：
- 如果有 P0/P1 问题：git checkout ${BRANCH}，修复所有 P0/P1 问题，push，然后 git checkout main && git pull
- 如果没有 P0/P1 问题：执行 gh pr merge ${PR_NUMBER} --merge --auto --delete-branch，然后 git checkout main && git pull
EOF
      exit 0
      ;;

    ci_running_reviewed)
      # Nothing to do for this PR — fall through to Phase B
      ;;

    ci_passed)
      # Enable auto-merge directly — no subagent needed
      gh pr merge "$PR_NUMBER" --repo "$REPO" --merge --auto --delete-branch 2>/dev/null || true
      # Fall through to Phase B
      ;;
  esac
fi

# --- Phase B: Implement new issue ---

NEXT_ISSUE_JSON=$("$SCRIPT_DIR/next-issue.sh" "$LABEL" || true)

if [ -n "$NEXT_ISSUE_JSON" ]; then
  ISSUE_NUMBER=$(echo "$NEXT_ISSUE_JSON" | jq -r '.number')
  ISSUE_TITLE=$(echo "$NEXT_ISSUE_JSON" | jq -r '.title')

  # Download and security-filter issue content
  if download_issue_content "$ISSUE_NUMBER"; then
    output_action
    cat <<EOF
开一个 subagent，对 issue #${ISSUE_NUMBER} 进行开发。

issue 标题: ${ISSUE_TITLE}
issue 内容见: ${CONTENT_DIR}/issues/${ISSUE_NUMBER}.md

开发流程：
1. 检查 /tmp/deep-dive/ 下是否有这个 issue 的 artifacts (research.md, innovate.md, plan.md)
2. 如果没有，先运行 /issue-plan
3. 然后运行 /issue-action
4. PR 创建后，添加 label: gh pr edit <PR_NUMBER> --add-label "${LABEL}"
5. 完成后回到 main: git checkout main && git pull
EOF
    exit 0
  fi
  # If download failed (untrusted author), fall through to idle
fi

# --- Nothing to do ---

output_idle
