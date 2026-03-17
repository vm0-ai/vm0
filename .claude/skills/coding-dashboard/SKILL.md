---
name: coding-dashboard
description: Dashboard view of CI pipeline, open issues/PRs by worker lane, and recently merged PRs.
context: fork
---

# Coding Dashboard

Provides a consolidated view of CI pipeline health, open issues/PRs by worker lane, and recently merged PRs.

## Arguments

Your args are: `$ARGUMENTS`

The first argument (optional) is the **maximum worker count** (default **4**).

```bash
# Example: /coding-dashboard → vm01-vm04
# Example: /coding-dashboard 8 → vm01-vm08
MAX_WORKERS=${1:-4}
```

If no argument is provided, default to `MAX_WORKERS=4`.

---

## Steps

### Step 0: Reset to Main

Ensure a clean, up-to-date working tree before querying:

```bash
git checkout main
git pull
git checkout -- .
```

### Step 1: Determine Parameters

```bash
MAX_WORKERS="${ARGUMENTS:-4}"
ME=$(gh api user --jq '.login')
```

Generate lane labels: `vm01`, `vm02`, ..., `vm0N` using `printf "vm%02d" $i`.

### Step 2: Check Main CI Pipeline

Query the last 10 workflow runs on `main`:

```bash
gh run list --workflow turbo.yml --branch main --limit 10 \
  --json databaseId,conclusion,url,name,headBranch,createdAt \
  --jq '.[] | {id: .databaseId, conclusion, url, createdAt}'
```

- If **all runs** have `conclusion == "success"`, report: "All green, no failures."
- If **any run** has `conclusion == "failure"`:
  1. Get the failed job names for that run:
     ```bash
     gh run view <RUN_ID> --json jobs --jq '[.jobs[] | select(.conclusion == "failure") | .name]'
     ```
  2. Post to Slack `#flaky-test` channel using the Slack MCP tool (`slack_send_message` to `#flaky-test`). Use Slack mrkdwn link syntax `<url|display text>` for all URLs so they render as clickable links. Example message format:
     ```
     🔴 main CI failure
     Failed jobs: lint, test
     Run: <https://github.com/vm0-ai/vm0/actions/runs/12345|#12345>
     ```
  3. Report the failure in the dashboard output.

### Step 3: Check Release Status

Query release-related information to show pending and in-progress releases.

#### Step 3a: Check Open Release PR

Find the open release PR created by the github-actions bot (title: "chore: release main") and extract its changelog:

```bash
# Find release PR (authored by github-actions bot with title "chore: release main")
gh pr list --repo vm0-ai/vm0 --author "app/github-actions" --state open \
  --json number,title,body --limit 1 \
  --jq '.[0] | select(.title == "chore: release main") | {number, title, body}'
```

If a release PR exists, parse the PR body to extract change titles. The release PR body contains changelog entries inside `<details>` blocks in markdown format (`* <title>` lines). Filter out dependency-only lines and deduplicate:

```bash
# Extract change titles from PR body, excluding dependency update noise and deduplicating
gh pr view <PR_NUMBER> --repo vm0-ai/vm0 --json body \
  --jq '.body' | grep -E '^\* ' | grep -v 'The following workspace dependencies were updated' | sort -u | sed 's/^\* /- /'
```

#### Step 3b: Check In-Progress Release Deployment

Check if the `release-please.yml` workflow has an in-progress run, and if so, extract the changes being deployed:

```bash
# Check for in-progress release-please workflow run
RELEASE_RUN=$(gh run list --repo vm0-ai/vm0 --workflow release-please.yml --status in_progress --limit 1 \
  --json databaseId,headSha --jq '.[0] | {id: .databaseId, sha: .headSha} // empty')
```

If an in-progress run exists, get the release commit's changes. The release commit created by release-please aggregates multiple changes. Extract the change titles from the commit message or the associated release PR body:

```bash
# Get the commit message which contains the changelog
gh api repos/vm0-ai/vm0/git/commits/<HEAD_SHA> --jq '.message' | grep -E '^\* ' | sed 's/^\* /- /'
```

#### Step 3c: Output

- If an open release PR exists, show its number and list of change titles
- If a release-please workflow is in-progress, show the changes being deployed
- If neither exists, skip this section entirely (do not show "Release Status" header)

### Step 4: Check Open Issues per Lane

For each lane `vm01` through `vm0N`:

```bash
gh issue list --repo vm0-ai/vm0 --label "$LANE" --assignee "$ME" --state open \
  --json number,title,labels --limit 50 \
  --jq '.[] | {number, title, pending: ([.labels[].name] | any(. == "pending"))}'
```

Also check issues where the current user is the author:

```bash
gh issue list --repo vm0-ai/vm0 --label "$LANE" --author "$ME" --state open \
  --json number,title,labels --limit 50 \
  --jq '.[] | {number, title, pending: ([.labels[].name] | any(. == "pending"))}'
```

Deduplicate by issue number. Mark items with `pending` label as `[Pending]`.

### Step 5: Check Open PRs per Lane

For each lane `vm01` through `vm0N`:

```bash
gh pr list --repo vm0-ai/vm0 --label "$LANE" --author "$ME" --state open \
  --json number,title,labels --limit 50 \
  --jq '.[] | {number, title, pending: ([.labels[].name] | any(. == "pending"))}'
```

Mark items with `pending` label as `[Pending]`.

### Step 6: List Recently Merged PRs

Query the last 20 merged PRs across all lanes:

```bash
for i in $(seq 1 $MAX_WORKERS); do
  LANE=$(printf "vm%02d" $i)
  gh pr list --repo vm0-ai/vm0 --label "$LANE" --state merged \
    --json number,title,mergedAt,labels --limit 20 \
    --jq ".[] | {number, title, mergedAt, lane: \"$LANE\"}"
done
```

Combine results, sort by `mergedAt` descending, take the top 20.

---

## Output Format

- Titles should be translated to Chinese
- Items with `pending` label get a `[Pending]` marker
- Empty lanes show `-- idle`
- Merged PRs shown as a list, each line: `Time #ID Lane — Title`

### Output Example

```
---
CI 流水线

全部通过，无失败。

Release 状态

📦 Open Release PR (#4950):
- feat: add user authentication system
- fix: resolve database connection timeout
- refactor: remove deprecated auth middleware

🚀 正在上线 (release-please in progress):
- feat: add user authentication system
- fix: resolve database connection timeout

通道状态

vm01
- Issue #4730 — 添加邮件退订功能 (List-Unsubscribe header + bounce/complaint webhook)
- PR #4735 — 添加邮件退订功能

vm02
- [Pending] Issue #4740 — 重构通知服务重试逻辑
- PR #4741 — 重构通知服务重试逻辑

vm03 -- idle

vm04
- Issue #4738 — 修复 webhook 签名验证失败

---
近期完成 (最近 20 个已合并 PR，按时间倒序)

- 3/13 08:35 #4728 vm03 — 升级平台 vite 从 v6 到 v7
- 3/13 08:01 #4719 vm01 — 通过 tsx/tsup 升级去重 esbuild 版本
---
```

---

## Key Rules

- Use `printf "vm%02d"` for label generation (consistent with coding-assign/coding-loop)
- Use `gh` CLI for all GitHub queries
- Use Slack MCP (`slack_send_message`) for `#flaky-test` notifications
- Current user determined via `gh api user --jq '.login'`
- No "new" markers — only `[Pending]` for items with `pending` label
- Deduplicate issues that appear in both author and assignee queries
- Translate titles to Chinese in the output
