---
name: my-issues
description: List open issues created by or assigned to the current user, deduplicated and prioritized.
context: fork
---

# My Issues

List all open GitHub issues that are **assigned to me** or **created by me (with assignee empty or myself)**, deduplicate, and present them sorted by priority.

## Arguments

Your args are: `$ARGUMENTS`

No arguments required.

## Steps

### Step 1: Determine Current User

```bash
ME=$(gh api user --jq '.login')
```

### Step 2: Fetch Issues

Run two queries in parallel:

```bash
# Issues assigned to me
gh issue list --assignee "$ME" --state open \
  --json number,title,labels,assignees,author,createdAt,updatedAt \
  --limit 50

# Issues authored by me
gh issue list --author "$ME" --state open \
  --json number,title,labels,assignees,author,createdAt,updatedAt \
  --limit 50
```

### Step 3: Filter and Deduplicate

1. From **assigned to me**: include all.
2. From **authored by me**: only include if assignee list is **empty** or **contains only me**. Exclude issues assigned to other people (they own those issues now).
3. Deduplicate by issue number.

### Step 4: Classify and Prioritize

Categorize each issue by reading its title, labels, and body (fetch body for each issue). Apply the following priority rules:

| Priority | Criteria |
|----------|----------|
| **P0** | Bugs or missing features that **block core user flows** (e.g., broken interactions, missing UI components, data loss) |
| **P1** | Important UX issues, newly assigned tasks, features affecting daily user experience |
| **P2** | Minor UI polish, experience optimizations, larger features that need scoping |
| **P3** | Long-term / operational tasks, nice-to-haves |

### Step 5: Output

Output in Chinese. Use the following format:

```
## 我的 Open Issues（共 N 个）

### P0 — 阻塞核心功能

| # | 标题 | 类型 | 来源 | 创建时间 |
|---|------|------|------|----------|
| #1234 | 简短描述 | Bug | @author → 我 | 03-19 |

### P1 — 重要需求

...same table format...

### P2 — 体验优化

...same table format...

### P3 — 长期 / 运营

...same table format...
```

Column definitions:
- **类型**: Bug / 新功能 / 重构 / 运营 — inferred from title prefix and labels
- **来源**: Show as `@author → 我` if assigned by others, `我创建` if self-created and self-assigned, `我创建 (未分配)` if self-created with no assignee

### Step 6: Suggested Execution Order

After the table, add a brief **建议执行顺序** section with a numbered list explaining the recommended order and any dependency relationships between issues.

## Key Rules

- Use `gh` CLI for all GitHub queries
- Always deduplicate by issue number
- Exclude issues created by me but assigned to someone else
- Translate titles to Chinese in the output
- Fetch issue body (first 500 chars) to make informed priority decisions
- Current user determined via `gh api user --jq '.login'`
