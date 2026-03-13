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

### Step 3: Count Issues Per Worker

For each worker label (`vm01` through `vm0N`), count open issues assigned to the current user:

```bash
for i in $(seq 1 $MAX_WORKERS); do
  LABEL=$(printf "vm%02d" "$i")
  COUNT=$(gh issue list --repo vm0-ai/vm0 --label "$LABEL" --assignee "$ME" --state open --json number --jq 'length')
  echo "$LABEL: $COUNT"
done
```

**Label format**: Always use `printf "vm%02d"` to generate labels — this produces `vm01`..`vm09` for single digits and `vm10`..`vm99` for double digits. Never use `seq -w` combined with string concatenation, as it produces wrong formats like `vm001` when workers > 9.

### Step 4: Select Least-Loaded Worker

Pick the worker label with the fewest open issues. If there's a tie, pick the lowest-numbered worker.

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

Worker load:
  vm01: 3 issues
  vm02: 2 issues  <-- assigned here
  vm03: 3 issues
  ...
```

---

## Key Rules

- **Always pick the least-loaded worker** — balance is the primary goal
- **Break ties by lowest number** — prefer `vm01` over `vm02` when equal
- **Remove `pending` label** — the issue is no longer waiting for human input
- **Create labels on demand** — if `vm0N` label doesn't exist, create it
- **One label per issue** — do not add multiple worker labels; if the issue already has a different worker label, remove it first
