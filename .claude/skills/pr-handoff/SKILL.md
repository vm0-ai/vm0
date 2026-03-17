---
name: pr-handoff
description: Create or update a PR and hand it off to a coding agent worker via load balancing. Removes pending label if present, then assigns a worker.
context: fork
---

# PR Handoff Skill

You are a PR handoff specialist. Your role is to create or update a pull request and hand it off to a coding agent worker using load balancing. A key use case is when a human has resolved a `pending` PR (one that needed human intervention) and wants to hand it back to an agent.

## Arguments

Your args are: `$ARGUMENTS`

Parse the args to determine:

1. **Label parameter** (`^`): If the args contain `^` followed by a label name (e.g., `^urgent`), apply that label to the PR in addition to the worker label
2. **Worker count** (optional number): The number of coding workers for distribution. Defaults to **4** if not provided.

### Argument Examples

```
# No args — create/update PR, distribute across 4 workers
/pr-handoff

# Specify 8 workers
/pr-handoff 8

# With a specific label
/pr-handoff ^urgent

# With label and 6 workers
/pr-handoff ^backend 6
```

**Parsing rules:**
- A bare number (e.g., `4`, `8`) is the worker count
- `^label-name` is the label parameter — the `^` character followed immediately by the label name
- Arguments can appear in any order
- Defaults: worker count = `4`, label = none

---

## Workflow

This skill runs in two phases: **Create/Update PR** then **Assign Worker**.

---

## Phase 1: Create or Update PR

### Step 1: Check if PR Already Exists

```bash
existing_pr=$(gh pr view --json number,url,labels 2>/dev/null)
```

### Step 2a: No Existing PR → Use `/pr-create`

If no PR exists for this branch, delegate to the `pull-request create` skill to handle the full PR creation workflow (including branch creation from main if needed, staging, committing, pushing, and opening the PR):

```typescript
Skill({ skill: "pull-request", args: "create" })
```

After `/pr-create` completes, capture the PR number and proceed to Phase 2.

### Step 2b: Existing PR → Push Any Pending Changes

If a PR already exists:

1. Check for uncommitted changes: `git status`
2. If there are changes, stage, commit, and push:
   ```bash
   git add -A
   git commit -m "<type>: <description>"
   git push
   ```
3. If no changes, that's fine — proceed directly to Phase 2

**Commit message rules:** Type must be lowercase, description starts lowercase, no period, under 100 chars, imperative mood.

---

## Phase 2: Assign to Coding Worker

After the PR is created or updated, assign it to a coding agent worker.

### Step 1: Capture PR Number and Labels

Extract the PR number from Phase 1. Check current labels on the PR:

```bash
PR_LABELS=$(gh pr view $PR_NUMBER --json labels --jq '.labels[].name')
```

### Step 2: Remove `pending` Label (if present)

The `pending` label means the PR was waiting for human intervention. Since the human is now handing it off, remove it:

```bash
if echo "$PR_LABELS" | grep -q "^pending$"; then
  gh pr edit $PR_NUMBER --remove-label "pending"
fi
```

### Step 3: Check for Existing Worker Label

If the PR already has a worker label (`vm01`..`vm99`), **keep it** — the PR should go back to the same worker that was working on it.

```bash
EXISTING_WORKER=$(echo "$PR_LABELS" | grep -E "^vm[0-9]{2}$" | head -1)
```

If `EXISTING_WORKER` is set, skip Steps 4-5 and go directly to Step 6 (report).

### Step 4: Get Current User and Count Issues + PRs Per Worker

Only runs if PR has no existing worker label.

```bash
ME=$(gh api user --jq '.login')

MAX_WORKERS=<from args or 4>
for i in $(seq 1 $MAX_WORKERS); do
  LABEL=$(printf "vm%02d" "$i")
  ISSUE_COUNT=$(gh issue list --repo vm0-ai/vm0 --label "$LABEL" --assignee "$ME" --state open --json number --jq 'length')
  PR_COUNT=$(gh pr list --repo vm0-ai/vm0 --label "$LABEL" --author "$ME" --state open --json number --jq 'length')
  TOTAL=$((ISSUE_COUNT + PR_COUNT))
  echo "$LABEL: $TOTAL (issues: $ISSUE_COUNT, PRs: $PR_COUNT)"
done
```

**Label format**: Always use `printf "vm%02d"` to generate labels — this produces `vm01`..`vm09` for single digits and `vm10`..`vm99` for double digits.

### Step 5: Apply Worker Label

Pick the worker label with the lowest total (issues + PRs). Prefer workers with **zero** total items. Break ties by lowest number.

```bash
gh label create "$SELECTED_LABEL" --description "Coding worker $SELECTED_LABEL" --color 0E8A16 2>/dev/null || true
gh pr edit $PR_NUMBER --add-label "$SELECTED_LABEL"
```

If `^label` was specified, add it too:
```bash
gh label create "$EXTRA_LABEL" --color EDEDED 2>/dev/null || true
gh pr edit $PR_NUMBER --add-label "$EXTRA_LABEL"
```

### Step 6: Report

Output a combined summary:

```
PR handed off: https://github.com/owner/repo/pull/123
Mode: <created / updated>
Assigned to worker: <LABEL> <(existing) if kept>
Pending label: <removed / not present>

Worker load (issues + PRs):
  vm01: 3 (issues: 2, PRs: 1)
  vm02: 0 (issues: 0, PRs: 0)  <-- assigned here
  vm03: 3 (issues: 1, PRs: 2)
  vm04: 4 (issues: 3, PRs: 1)
```

---

## Key Rules

- **Delegate PR creation to `/pr-create`** — don't reimplement branch creation or PR creation logic
- **Create or update — both work** — the skill handles either case
- **Remove `pending` label** — this signals the PR is ready for agent work again
- **Preserve existing worker label** — if the PR already has a worker label, keep it (same agent should continue)
- **Only assign new worker if none exists** — load balance only for fresh assignments
- **Always pick the least-loaded worker** — balance is the primary goal
- **Break ties by lowest number** — prefer `vm01` over `vm02` when equal
- **Create labels on demand** — if `vm0N` label doesn't exist, create it
- **One worker label per PR** — do not add multiple worker labels
- **`^label` is additive** — it does not replace default labels, it adds to them
- **Display the PR URL** — always show the URL to the user at the end
