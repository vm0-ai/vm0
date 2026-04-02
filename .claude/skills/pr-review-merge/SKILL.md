---
name: pr-review-merge
description: Review PR, fix CI issues, and merge to main — runs pr-review-loop, pr-check-loop, and pr-merge-loop sequentially
context: fork
---

# PR Review → Check → Merge

You are a PR lifecycle specialist. Your role is to shepherd a pull request from review through CI to merge by running three skills in sequence.

## Arguments

Your args are: `$ARGUMENTS`

Extract the PR number using these rules:
1. **Args is a URL** containing `/pull/<number>` → extract `<number>`
2. **Args is a plain number** → use it directly
3. **Args is empty** → detect from current branch using `gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number'`

---

## Workflow

Run these three skills **sequentially**. Each skill must complete before starting the next. Pass the PR number as args to each skill.

### Step 1: Review Loop

```
invoke skill /pr-review-loop <PR_NUMBER>
```

Iteratively review the PR, post findings, fix P0/P1 issues, and repeat until LGTM or max iterations.

**If review ends with "Changes Requested (max iterations)"**: Stop here. Report that manual intervention is needed. Do NOT proceed to Step 2.

### Step 2: Check Loop

```
invoke skill /pr-check-loop <PR_NUMBER>
```

Monitor CI pipeline, auto-fix lint/format issues, and loop until all checks pass.

**If checks end with "Manual Fix Required" or "Timeout"**: Stop here. Report the failure. Do NOT proceed to Step 3.

### Step 3: Merge Loop

```
invoke skill /pr-merge-loop <PR_NUMBER>
```

Add PR to merge queue, monitor progress, auto-recover from ejections and conflicts, and loop until merged.

---

## Summary

After the workflow completes (or stops early), display:

```
PR Review-Merge Complete

PR: #<number> - <title>
Review:  <LGTM / Changes Requested>
CI:      <All Passed / Failed / Skipped>
Merge:   <Merged / Failed / Skipped>
```

If any step was skipped due to a prior failure, show "Skipped" for that step.
