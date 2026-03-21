---
name: coding-assign
description: Balance-assign a pending issue to a coding worker (vm01-vm0N) based on current workload.
context: fork
---

# Coding Assign

Assigns the current working issue to a coding worker label (`vm01`–`vm0N`) using load balancing, ensuring even distribution of issues across workers.

## Arguments

Your args are: `$ARGUMENTS`

The first argument is the **maximum number of workers** (optional, defaults to **4**). For example, `coding-assign 8` means workers `vm01` through `vm08`.

```bash
# Example: /coding-assign 8
MAX_WORKERS=8

# Example: /coding-assign  (no args — defaults to 4)
MAX_WORKERS=4
```

If no argument is provided, default to `MAX_WORKERS=4` (uniform distribution across `vm01`–`vm04`).

## Prerequisites

This skill expects a **current working issue** in the conversation context. If no issue has been discussed, ask the user for the issue number.

---

## Workflow

### Step 1: Parse Arguments and Identify Issue

1. Parse the max worker count from arguments.
2. Identify the current issue number from conversation context.
3. Validate both are present.

```bash
MAX_WORKERS=<parsed from args>
ISSUE=<from conversation context>
```

### Step 2: Get Current User

```bash
ME=$(gh api user --jq '.login')
```

### Step 3: Count Issues and PRs Per Worker

Fetch all lane data in a single parallel call:

```bash
FIRST_LANE=$(printf "vm%02d" 1)
LAST_LANE=$(printf "vm%02d" $MAX_WORKERS)
LANES=$(scripts/lane-status.sh "${FIRST_LANE}-${LAST_LANE}" --user "$ME")
```

This queries all lanes **in parallel** and returns issue/PR counts per lane. Extract the load per lane:

```bash
echo "$LANES" | jq '.[] | {lane, issue_count, pr_count, total}'
```

### Step 4: Select Least-Loaded Worker

Pick the worker label with the lowest total (issues + PRs). Prefer workers with **zero** total items. If there's a tie, pick the lowest-numbered worker.

### Step 5: Update Issue Labels

1. **Remove `pending` label** (if present):
   ```bash
   gh issue edit $ISSUE --remove-label "pending"
   ```

2. **Add the selected worker label**:
   ```bash
   gh issue edit $ISSUE --add-label "$SELECTED_LABEL"
   ```

3. **Ensure the label exists** — if the label doesn't exist yet, create it:
   ```bash
   gh label create "$SELECTED_LABEL" --description "Coding worker $SELECTED_LABEL" --color 0E8A16 2>/dev/null || true
   ```

### Step 6: Report

Output a summary:

```
Issue #<NUMBER> assigned to worker <LABEL>

Worker load (issues + PRs):
  vm01: 3 (issues: 2, PRs: 1)
  vm02: 0 (issues: 0, PRs: 0)  <-- assigned here
  vm03: 3 (issues: 1, PRs: 2)
  ...
```

---

## Key Rules

- **Always pick the least-loaded worker** — balance is the primary goal
- **Break ties by lowest number** — prefer `vm01` over `vm02` when equal
- **Remove `pending` label** — the issue is no longer waiting for human input
- **Create labels on demand** — if `vm0N` label doesn't exist, create it
- **One label per issue** — do not add multiple worker labels; if the issue already has a different worker label, remove it first
