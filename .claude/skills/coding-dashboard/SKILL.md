---
name: coding-dashboard
description: Dashboard view of CI pipeline, merge queue, open issues/PRs by worker lane, and recently merged PRs.
context: fork
---

# Coding Dashboard

Provides a consolidated view of CI pipeline health, merge queue status, open issues/PRs by worker lane, and recently merged PRs.

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

### Step 2: Get Pipeline Status (CI + Merge Queue + Release)

Fetch all pipeline data in a single call:

```bash
PIPELINE=$(scripts/pipeline-status.sh)
```

This runs CI pipeline check, merge queue GraphQL query, and release PR check **in parallel** and returns unified JSON with `ci_runs`, `merge_queue`, and `release` sections.

#### CI Pipeline Display

Extract CI runs and display status line:
```bash
echo "$PIPELINE" | jq '.ci_runs'
```

Display a status line showing all 10 runs in order (most recent first), using ✅ for success and 🔴 for failure.

- If **all runs** have `conclusion == "success"`, report: "全部通过，无失败"
- If **any run** has `conclusion == "failure"`:
  1. Identify the **most recent failed run**. Track its position (1-indexed).
  2. Get the failed job names: `gh run view <RUN_ID> --json jobs --jq '[.jobs[] | select(.conclusion == "failure") | .name]'`
  3. Calculate **success count since last failure** (position - 1).
  4. Calculate **time elapsed since the failure** (human-readable duration).
  5. Post to Slack using the Slack MCP tool (`slack_send_message` with `channelId: C0ALXC1SHHN`). Do NOT mention or @ any users. Use Slack mrkdwn link syntax `<url|display text>`.

#### Merge Queue Display

Extract merge queue entries:
```bash
echo "$PIPELINE" | jq '.merge_queue'
```

For each entry, map `ci_state` to emoji: `SUCCESS` → ✅, `FAILURE`/`ERROR` → 🔴, `PENDING`/`EXPECTED`/missing → ⏳

#### Release Status Display

Extract release info:
```bash
echo "$PIPELINE" | jq '.release'
```

- If `release` is not null and has `open_pr`, show PR number and change list
- If `release.in_progress_run` is not null, show changes being deployed
- If `release` is null, skip this section entirely

### Step 5: Get Lane Status (Issues + PRs per Lane)

Fetch all lane data in a single call with parallel queries:

```bash
FIRST_LANE=$(printf "vm%02d" 1)
LAST_LANE=$(printf "vm%02d" $MAX_WORKERS)
LANES=$(scripts/lane-status.sh "${FIRST_LANE}-${LAST_LANE}" --user "$ME")
```

This queries all lanes **in parallel** (issues assigned + authored, PRs authored) and returns unified JSON with deduplication already handled.

For each lane in the output, display issues and PRs. Mark items with `pending: true` as `[Pending]`. Empty lanes show `-- idle`.

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
📊 主分支 CI 流水线（最近 10 次）
✅✅✅🔴✅✅✅✅✅✅

最近一次失败: 第 4/10 次
  Run: https://github.com/vm0-ai/vm0/actions/runs/123456
  失败 Jobs: deploy, cli-e2e
  此后连续成功: 3 次
  距今: 2 小时 15 分钟

🚦 Merge Queue

- ✅ #5680 — feat: add files:write scope to Slack connector (e7h4n)
- ⏳ #5685 — fix: persist trigger source when enqueueing runs (e7h4n)

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
- Use Slack MCP (`slack_send_message` with `channelId: C0ALXC1SHHN`) for flaky test notifications — do NOT mention or @ any users
- Current user determined via `gh api user --jq '.login'`
- No "new" markers — only `[Pending]` for items with `pending` label
- Deduplicate issues that appear in both author and assignee queries
- Translate titles to Chinese in the output
