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
  2. Post to Slack `#flaky-test` channel with the failed run details (run URL, failed job names) using the Slack MCP tool (`slack_send_message` to `#flaky-test`).
  3. Report the failure in the dashboard output.

### Step 3: Check Open Issues per Lane

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

### Step 4: Check Open PRs per Lane

For each lane `vm01` through `vm0N`:

```bash
gh pr list --repo vm0-ai/vm0 --label "$LANE" --author "$ME" --state open \
  --json number,title,labels --limit 50 \
  --jq '.[] | {number, title, pending: ([.labels[].name] | any(. == "pending"))}'
```

Mark items with `pending` label as `[Pending]`.

### Step 5: List Recently Merged PRs with Release Status

#### Step 5a: Get Release Reference Points

Fetch the latest GitHub Release tag and its commit SHA, and check for in-progress release-please runs:

```bash
# Latest release tag and commit
LATEST_TAG=$(gh release list --repo vm0-ai/vm0 --limit 1 --json tagName --jq '.[0].tagName')
RELEASE_SHA=$(gh api repos/vm0-ai/vm0/releases/tags/$LATEST_TAG --jq '.target_commitish')

# In-progress release-please workflow
RUNNING_SHA=$(gh run list --repo vm0-ai/vm0 --workflow release-please.yml --status in_progress --limit 1 --json headSha --jq '.[0].headSha // empty')
```

#### Step 5b: Query Merged PRs

Query the last 20 merged PRs across all lanes, including merge commit SHA:

```bash
for i in $(seq 1 $MAX_WORKERS); do
  LANE=$(printf "vm%02d" $i)
  gh pr list --repo vm0-ai/vm0 --label "$LANE" --state merged \
    --json number,title,mergedAt,labels,mergeCommit --limit 20 \
    --jq ".[] | {number, title, mergedAt, lane: \"$LANE\", mergeCommitSha: .mergeCommit.oid}"
done
```

Combine results, sort by `mergedAt` descending, take the top 20.

#### Step 5c: Annotate Each PR with Release Status

For each merged PR, classify its release status using the merge commit SHA:

```bash
git merge-base --is-ancestor <mergeCommitSha> $RELEASE_SHA && echo "✅" || ([ -n "$RUNNING_SHA" ] && echo "🚀" || echo "⏳")
```

| Marker | Meaning | Condition |
|--------|---------|-----------|
| ✅ | Released | PR merge commit is an ancestor of the latest release commit |
| 🚀 | Releasing | Not yet released, but release-please workflow is in progress |
| ⏳ | Pending release | Not yet released, no release-please run in progress |

Prepend the marker to each PR line in the output.

---

## Output Format

- Titles should be translated to Chinese
- Items with `pending` label get a `[Pending]` marker
- Empty lanes show `-- idle`
- Merged PRs shown as a list, each line: `Marker Time #ID Lane — Title`
- Release status markers: ✅ (released), 🚀 (releasing), ⏳ (pending release)

### Output Example

```
---
CI 流水线

全部通过，无失败。

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

- ✅ 3/13 08:35 #4728 vm03 — 升级平台 vite 从 v6 到 v7
- 🚀 3/13 08:01 #4719 vm01 — 通过 tsx/tsup 升级去重 esbuild 版本
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
